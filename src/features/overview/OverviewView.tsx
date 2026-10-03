import { useEffect, useMemo } from "react";
import { Activity, ArrowDownToLine, ArrowUpFromLine, Clock, Container, Cpu, FolderTree, HardDrive, MemoryStick, Network, ScrollText, Terminal, Timer } from "lucide-react";
import type { MetricsSnapshot } from "@/types/generated";
import { api } from "@/services/api";
import { useSettings } from "@/stores/settings";
import { useServers } from "@/stores/servers";
import type { Tab } from "@/stores/workspace";
import { useAsync } from "@/hooks/useAsync";
import { AreaChart, Ring } from "@/components/Charts";
import { Card, Progress, Segmented, Spinner, usageTone } from "@/components/ui";
import { formatBytes, formatBytesPair, formatDuration, formatPercent, formatRate } from "@/lib/format";
import { ConnectGate } from "../servers/ConnectGate";
import { openTool } from "../servers/actions";

const INTERVALS = [
  { value: "1000", label: "1s" },
  { value: "2000", label: "2s" },
  { value: "5000", label: "5s" },
  { value: "10000", label: "10s" },
  { value: "30000", label: "30s" },
];

function Stat({ icon, label, value, sub, ring, ringColor }: { icon: React.ReactNode; label: string; value: string; sub?: React.ReactNode; ring?: number; ringColor?: string }) {
  return (
    <div className="rounded-xl border border-line bg-bg-2 p-4 flex items-center gap-4 min-w-0">
      {ring != null ? (
        <Ring value={ring} size={58} stroke={6} color={ringColor}>
          <span className="text-[12px] font-semibold text-fg tabular">{Math.round(ring)}%</span>
        </Ring>
      ) : (
        <div className="h-[58px] w-[58px] rounded-full bg-bg-3 flex items-center justify-center text-fg-3 shrink-0">{icon}</div>
      )}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-3">
          {icon}
          {label}
        </div>
        <div className="text-[20px] font-semibold text-fg tabular leading-tight mt-0.5 truncate">{value}</div>
        {sub && <div className="text-[11.5px] text-fg-3 truncate">{sub}</div>}
      </div>
    </div>
  );
}

function Overview({ serverId, active }: { serverId: string; active: boolean }) {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const m = useServers((s) => s.metrics[serverId]);
  const history = useServers((s) => s.history[serverId]);
  const seed = useServers((s) => s.seedHistory);
  const info = useAsync(() => api.systemInfo(serverId), [serverId]);

  // Fast polling while visible; background rate otherwise.
  useEffect(() => {
    void api.monitorStart(serverId, active ? settings.monitorIntervalMs : settings.backgroundMonitorIntervalMs);
  }, [serverId, active, settings.monitorIntervalMs, settings.backgroundMonitorIntervalMs]);
  useEffect(() => {
    void api.monitorHistory(serverId).then((h) => seed(serverId, h));
    return () => void api.monitorStart(serverId, useSettings.getState().settings.backgroundMonitorIntervalMs).catch(() => {});
  }, [serverId, seed]);

  const h: MetricsSnapshot[] = history ?? [];
  const series = useMemo(
    () => ({
      cpu: h.map((x) => x.cpuPercent),
      mem: h.map((x) => (x.memTotal ? (x.memUsed / x.memTotal) * 100 : 0)),
      rx: h.map((x) => x.netRxBps),
      tx: h.map((x) => x.netTxBps),
      load: h.map((x) => x.load1),
    }),
    [h],
  );

  if (!m)
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-fg-3">
        <Spinner size={20} className="text-accent" />
        <span className="text-[13px]">Collecting metrics…</span>
      </div>
    );

  const memPct = m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0;
  const swapPct = m.swapTotal ? (m.swapUsed / m.swapTotal) * 100 : 0;
  const root = m.disks.find((d) => d.mount === "/") ?? m.disks[0];
  const rootPct = root ? (root.usedBytes / Math.max(1, root.totalBytes)) * 100 : 0;
  const color = (p: number) => (p >= 90 ? "var(--danger)" : p >= 75 ? "var(--warn)" : "var(--accent)");

  return (
    <div className="h-full overflow-auto">
      <div className="p-5 space-y-4 max-w-[1500px] mx-auto">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-[18px] font-semibold text-fg">{info.data?.hostname ?? "Server"}</h1>
            <p className="text-[12.5px] text-fg-3">
              {info.data ? `${info.data.os} · ${info.data.kernel} · ${info.data.arch} · ${info.data.cpuModel}` : <span className="skeleton inline-block h-3 w-72" />}
            </p>
          </div>
          <div className="flex-1" />
          <span className="text-[11.5px] text-fg-3">Refresh</span>
          <Segmented size="xs" value={String(settings.monitorIntervalMs)} onChange={(v) => void update({ monitorIntervalMs: Number(v) })} options={INTERVALS} />
        </div>

        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          <Stat icon={<Cpu size={12} />} label="CPU" value={formatPercent(m.cpuPercent)} sub={`${m.cpuCores} cores · load ${m.load1.toFixed(2)} ${m.load5.toFixed(2)} ${m.load15.toFixed(2)}`} ring={m.cpuPercent} ringColor={color(m.cpuPercent)} />
          <Stat icon={<MemoryStick size={12} />} label="Memory" value={formatBytesPair(m.memUsed, m.memTotal)} sub={`${formatBytes(m.memCached)} cache · swap ${formatBytes(m.swapUsed)} / ${formatBytes(m.swapTotal)}`} ring={memPct} ringColor={color(memPct)} />
          <Stat icon={<HardDrive size={12} />} label={`Disk ${root?.mount ?? ""}`} value={root ? formatBytesPair(root.usedBytes, root.totalBytes) : "—"} sub={root ? `${formatBytes(root.availBytes)} free · ${root.fsType}` : undefined} ring={rootPct} ringColor={color(rootPct)} />
          <Stat icon={<Network size={12} />} label="Network" value={`↓ ${formatRate(m.netRxBps)}`} sub={`↑ ${formatRate(m.netTxBps)} · total ↓${formatBytes(m.netRxTotal)} ↑${formatBytes(m.netTxTotal)}`} />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <Card title="CPU usage" actions={<span className="text-[11.5px] text-fg-3 tabular">{formatPercent(m.cpuPercent, 1)}</span>}>
            <AreaChart series={[{ values: series.cpu, color: "#7c5cff", label: "CPU" }]} max={100} format={(v) => `${v.toFixed(0)}%`} />
          </Card>
          <Card title="Memory" actions={<span className="text-[11.5px] text-fg-3 tabular">{formatPercent(memPct, 1)}</span>}>
            <AreaChart series={[{ values: series.mem, color: "#38bdf8", label: "Memory" }]} max={100} format={(v) => `${v.toFixed(0)}%`} />
          </Card>
          <Card
            title="Network"
            actions={
              <span className="text-[11.5px] text-fg-3 tabular flex gap-2">
                <span className="text-ok flex items-center gap-0.5">
                  <ArrowDownToLine size={11} />
                  {formatRate(m.netRxBps)}
                </span>
                <span className="text-warn flex items-center gap-0.5">
                  <ArrowUpFromLine size={11} />
                  {formatRate(m.netTxBps)}
                </span>
              </span>
            }
          >
            <AreaChart
              series={[
                { values: series.rx, color: "#22c55e", label: "Download" },
                { values: series.tx, color: "#f5a524", label: "Upload" },
              ]}
              format={(v) => formatRate(v)}
            />
          </Card>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <Card title="Disks" className="xl:col-span-2">
            <div className="space-y-3">
              {m.disks.map((d) => {
                const pct = (d.usedBytes / Math.max(1, d.totalBytes)) * 100;
                return (
                  <div key={d.mount} className="grid grid-cols-[minmax(120px,200px)_1fr_auto] items-center gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] text-fg font-mono truncate">{d.mount}</div>
                      <div className="text-[11px] text-fg-3 truncate">
                        {d.filesystem} · {d.fsType}
                      </div>
                    </div>
                    <Progress value={pct} tone={usageTone(pct)} />
                    <div className="text-[12px] text-fg-2 tabular text-right w-[150px]">
                      {formatBytes(d.usedBytes)} / {formatBytes(d.totalBytes)} <span className="text-fg-3">({pct.toFixed(0)}%)</span>
                    </div>
                  </div>
                );
              })}
              {!m.disks.length && <div className="text-[12.5px] text-fg-3">No physical filesystems reported.</div>}
            </div>
          </Card>
          <Card title="System">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[12.5px]">
              <dt className="text-fg-3 flex items-center gap-1.5">
                <Clock size={12} /> Uptime
              </dt>
              <dd className="text-fg tabular">{formatDuration(m.uptimeSecs)}</dd>
              <dt className="text-fg-3 flex items-center gap-1.5">
                <Activity size={12} /> Processes
              </dt>
              <dd className="text-fg tabular">{m.processCount}</dd>
              <dt className="text-fg-3 flex items-center gap-1.5">
                <Network size={12} /> Open ports
              </dt>
              <dd className="text-fg tabular">{m.listeningPorts ?? "—"}</dd>
              <dt className="text-fg-3 flex items-center gap-1.5">
                <Timer size={12} /> Latency
              </dt>
              <dd className="text-fg tabular">{m.latencyMs != null ? `${m.latencyMs} ms` : "—"}</dd>
              <dt className="text-fg-3">Swap</dt>
              <dd className="text-fg tabular">{formatPercent(swapPct)}</dd>
            </dl>
            <div className="grid grid-cols-2 gap-2 mt-4">
              {[
                { k: "terminal" as const, l: "Terminal", i: <Terminal size={13} /> },
                { k: "files" as const, l: "Files", i: <FolderTree size={13} /> },
                { k: "processes" as const, l: "Processes", i: <Activity size={13} /> },
                { k: "docker" as const, l: "Docker", i: <Container size={13} /> },
                { k: "logs" as const, l: "Logs", i: <ScrollText size={13} /> },
                { k: "ports" as const, l: "Ports", i: <Network size={13} /> },
              ].map((x) => (
                <button key={x.k} onClick={() => void openTool(serverId, x.k, {}, x.k === "terminal")} className="flex items-center gap-2 h-8 px-2.5 rounded-md border border-line bg-bg-1 hover:bg-bg-3 hover:border-line-2 text-[12px] text-fg-2">
                  {x.i}
                  {x.l}
                </button>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

export function OverviewView({ tab, active }: { tab: Tab; active: boolean }) {
  return (
    <ConnectGate serverId={tab.serverId!} what="see live monitoring">
      <Overview serverId={tab.serverId!} active={active} />
    </ConnectGate>
  );
}
