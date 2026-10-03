//! Byte-stream transports to reach an SSH server: direct TCP, SOCKS5 or HTTP
//! CONNECT proxies. (Jump hosts are handled by the connection manager, which
//! opens a `direct-tcpip` channel on the jump host's connection.)

use crate::error::{humanize_net_io, AppError, ErrorCode, NetCtx, Result};
use crate::model::{ProxyConfig, ProxyKind};
use crate::security::SecretString;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send + 'static {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + 'static> Io for T {}
pub type BoxIo = Box<dyn Io>;

pub async fn tcp_connect(host: &str, port: u16, timeout: Duration, ctx: &NetCtx) -> Result<TcpStream> {
    let fut = TcpStream::connect((host, port));
    let stream = match tokio::time::timeout(timeout, fut).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(humanize_net_io(&e, ctx)),
        Err(_) => {
            let e = std::io::Error::new(std::io::ErrorKind::TimedOut, format!("no response within {}s", timeout.as_secs()));
            return Err(humanize_net_io(&e, ctx));
        }
    };
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

fn proxy_err(msg: impl Into<String>, details: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::ProxyFailed, "Proxy connection failed", msg)
        .causes(["Check the proxy host, port and credentials", "The proxy may not allow connections to this destination"])
        .details(details)
}

/// Connect through a proxy to `target_host:target_port`.
pub async fn proxy_connect(
    proxy: &ProxyConfig,
    proxy_password: Option<&SecretString>,
    target_host: &str,
    target_port: u16,
    timeout: Duration,
) -> Result<TcpStream> {
    let ctx = NetCtx { host: proxy.host.clone(), port: proxy.port, what: "the proxy" };
    let mut s = tcp_connect(&proxy.host, proxy.port, timeout, &ctx).await?;
    let fut = async {
        match proxy.kind {
            ProxyKind::Socks5 => {
                socks5_handshake(&mut s, proxy.username.as_deref(), proxy_password.map(|p| p.expose()), target_host, target_port).await
            }
            ProxyKind::Http => {
                http_connect_handshake(&mut s, proxy.username.as_deref(), proxy_password.map(|p| p.expose()), target_host, target_port)
                    .await
            }
        }
    };
    match tokio::time::timeout(timeout, fut).await {
        Ok(Ok(())) => Ok(s),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(proxy_err("The proxy did not respond in time.", "handshake timeout")),
    }
}

pub async fn socks5_handshake<S: AsyncRead + AsyncWrite + Unpin>(
    s: &mut S,
    user: Option<&str>,
    pass: Option<&str>,
    host: &str,
    port: u16,
) -> Result<()> {
    let io = |e: std::io::Error| proxy_err("Lost connection to the SOCKS proxy.", e.to_string());
    let with_auth = user.is_some();
    if with_auth {
        s.write_all(&[5, 2, 0, 2]).await.map_err(io)?;
    } else {
        s.write_all(&[5, 1, 0]).await.map_err(io)?;
    }
    let mut resp = [0u8; 2];
    s.read_exact(&mut resp).await.map_err(io)?;
    if resp[0] != 5 {
        return Err(proxy_err("The proxy is not a SOCKS5 proxy.", format!("version byte {}", resp[0])));
    }
    match resp[1] {
        0 => {}
        2 => {
            let u = user.unwrap_or("");
            let p = pass.unwrap_or("");
            if u.len() > 255 || p.len() > 255 {
                return Err(proxy_err("Proxy username or password is too long.", ""));
            }
            let mut msg = vec![1u8, u.len() as u8];
            msg.extend_from_slice(u.as_bytes());
            msg.push(p.len() as u8);
            msg.extend_from_slice(p.as_bytes());
            s.write_all(&msg).await.map_err(io)?;
            let mut r = [0u8; 2];
            s.read_exact(&mut r).await.map_err(io)?;
            if r[1] != 0 {
                return Err(proxy_err("The proxy rejected the username or password.", "SOCKS5 auth failure"));
            }
        }
        0xff => return Err(proxy_err("The proxy requires an authentication method that is not configured.", "no acceptable methods")),
        m => return Err(proxy_err("Unsupported proxy authentication method.", format!("method {m}"))),
    }
    let mut req = vec![5u8, 1, 0];
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        match ip {
            std::net::IpAddr::V4(v4) => {
                req.push(1);
                req.extend_from_slice(&v4.octets());
            }
            std::net::IpAddr::V6(v6) => {
                req.push(4);
                req.extend_from_slice(&v6.octets());
            }
        }
    } else {
        if host.len() > 255 {
            return Err(proxy_err("Hostname too long for SOCKS5.", ""));
        }
        req.push(3);
        req.push(host.len() as u8);
        req.extend_from_slice(host.as_bytes());
    }
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req).await.map_err(io)?;
    let mut head = [0u8; 4];
    s.read_exact(&mut head).await.map_err(io)?;
    if head[1] != 0 {
        let why = match head[1] {
            1 => "general failure",
            2 => "connection not allowed by ruleset",
            3 => "network unreachable",
            4 => "host unreachable",
            5 => "connection refused",
            6 => "TTL expired",
            7 => "command not supported",
            8 => "address type not supported",
            _ => "unknown error",
        };
        return Err(proxy_err(format!("The proxy could not reach {host}:{port} ({why})."), format!("SOCKS5 reply {}", head[1])));
    }
    let skip = match head[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut l = [0u8; 1];
            s.read_exact(&mut l).await.map_err(io)?;
            l[0] as usize
        }
        _ => 0,
    };
    let mut rest = vec![0u8; skip + 2];
    s.read_exact(&mut rest).await.map_err(io)?;
    Ok(())
}

pub async fn http_connect_handshake<S: AsyncRead + AsyncWrite + Unpin>(
    s: &mut S,
    user: Option<&str>,
    pass: Option<&str>,
    host: &str,
    port: u16,
) -> Result<()> {
    let io = |e: std::io::Error| proxy_err("Lost connection to the HTTP proxy.", e.to_string());
    let authority = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let mut req = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Connection: keep-alive\r\n");
    if let Some(u) = user {
        let token = B64.encode(format!("{u}:{}", pass.unwrap_or("")));
        req.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).await.map_err(io)?;
    // Read the response headers byte-by-byte so no tunnel bytes are consumed.
    let mut buf = Vec::with_capacity(256);
    loop {
        let mut b = [0u8; 1];
        let n = s.read(&mut b).await.map_err(io)?;
        if n == 0 {
            return Err(proxy_err("The proxy closed the connection.", String::from_utf8_lossy(&buf).to_string()));
        }
        buf.push(b[0]);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
        if buf.len() > 16 * 1024 {
            return Err(proxy_err("The proxy sent an invalid response.", "header too large"));
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let status_line = head.lines().next().unwrap_or("");
    let code: u16 = status_line.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    match code {
        200..=299 => Ok(()),
        407 => Err(proxy_err("The proxy requires a valid username and password.", status_line.to_string())),
        403 => Err(proxy_err("The proxy refused to connect to this server.", status_line.to_string())),
        _ => Err(proxy_err(format!("The proxy returned an error ({code})."), status_line.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[tokio::test]
    async fn socks5_no_auth_domain() {
        let (mut client, mut server) = duplex(1024);
        let srv = crate::rt::spawn(async move {
            let mut b = [0u8; 3];
            server.read_exact(&mut b).await.unwrap();
            assert_eq!(b, [5, 1, 0]);
            server.write_all(&[5, 0]).await.unwrap();
            let mut h = [0u8; 5];
            server.read_exact(&mut h).await.unwrap();
            assert_eq!(&h[..4], &[5, 1, 0, 3]);
            let mut name = vec![0u8; h[4] as usize + 2];
            server.read_exact(&mut name).await.unwrap();
            assert_eq!(&name[..name.len() - 2], b"example.com");
            assert_eq!(u16::from_be_bytes([name[name.len() - 2], name[name.len() - 1]]), 22);
            server.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
        });
        socks5_handshake(&mut client, None, None, "example.com", 22).await.unwrap();
        srv.await.unwrap();
    }

    #[tokio::test]
    async fn socks5_refused_is_explained() {
        let (mut client, mut server) = duplex(1024);
        crate::rt::spawn(async move {
            let mut b = [0u8; 3];
            server.read_exact(&mut b).await.unwrap();
            server.write_all(&[5, 0]).await.unwrap();
            let mut h = [0u8; 10];
            server.read_exact(&mut h).await.unwrap();
            server.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
        });
        let e = socks5_handshake(&mut client, None, None, "10.0.0.1", 22).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::ProxyFailed);
        assert!(e.message.contains("connection refused"));
    }

    #[tokio::test]
    async fn http_connect_ok_and_407() {
        let (mut client, mut server) = duplex(4096);
        crate::rt::spawn(async move {
            let mut buf = vec![0u8; 512];
            let n = server.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            assert!(req.starts_with("CONNECT host:2222 HTTP/1.1"));
            assert!(req.contains("Proxy-Authorization: Basic dTpw"));
            server.write_all(b"HTTP/1.1 200 Connection established\r\n\r\nSSH-2.0-x").await.unwrap();
        });
        http_connect_handshake(&mut client, Some("u"), Some("p"), "host", 2222).await.unwrap();
        // the tunnel bytes after the header must still be readable
        let mut rest = [0u8; 9];
        client.read_exact(&mut rest).await.unwrap();
        assert_eq!(&rest, b"SSH-2.0-x");

        let (mut c2, mut s2) = duplex(4096);
        crate::rt::spawn(async move {
            let mut buf = vec![0u8; 512];
            let _ = s2.read(&mut buf).await.unwrap();
            s2.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n").await.unwrap();
        });
        let e = http_connect_handshake(&mut c2, None, None, "h", 22).await.unwrap_err();
        assert!(e.message.contains("username and password"));
    }
}
