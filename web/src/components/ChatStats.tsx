import { useState } from "react";

export interface CountResult {
  total: number;
  granted?: number;
  refused?: number;
  appealed?: number;
  domestic?: number;
  commenced?: number;
  by_status?: Record<string, number>;
  by_type?: Record<string, number>;
  by_year?: Record<string, number>;
  by_authority?: Record<string, number>;
}

const STATUS_COLORS: Record<string, string> = {
  granted: "#16a34a",
  refused: "#dc2626",
  pending: "#2563eb",
  further_info: "#d97706",
  withdrawn: "#6b7280",
  invalid: "#6b7280",
  split: "#9333ea",
};

const STATUS_LABELS: Record<string, string> = {
  granted: "Granted",
  refused: "Refused",
  pending: "Pending",
  further_info: "Further info",
  withdrawn: "Withdrawn",
  invalid: "Invalid",
  split: "Split decision",
  decided: "Decided",
  exempt: "Exempt",
  not_exempt: "Not exempt",
};

function Bar({ items, total }: { items: Array<{ key: string; count: number }>; total: number }) {
  if (total === 0) return null;
  return (
    <div className="stats-bar">
      {items.map((it) => {
        const pct = (it.count / total) * 100;
        if (pct < 1) return null;
        return (
          <div
            key={it.key}
            className="stats-bar-seg"
            style={{
              width: `${pct}%`,
              background: STATUS_COLORS[it.key] ?? "#94a3b8",
            }}
            title={`${STATUS_LABELS[it.key] ?? it.key}: ${it.count} (${Math.round(pct)}%)`}
          />
        );
      })}
    </div>
  );
}

function Breakdown({ label, data }: { label: string; data: Record<string, number> }) {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return (
    <div className="stats-breakdown">
      <button type="button" className="stats-breakdown-toggle" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {label}
      </button>
      {open && (
        <ul className="stats-breakdown-list">
          {entries.map(([k, v]) => (
            <li key={k}>
              <span className="stats-bd-key">{STATUS_LABELS[k] ?? k}</span>
              <span className="stats-bd-val">{v.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ChatStats({ data }: { data: CountResult }) {
  const statusItems = data.by_status
    ? Object.entries(data.by_status).map(([key, count]) => ({ key, count }))
    : [];

  const grantRate =
    data.granted != null && data.refused != null && data.granted + data.refused > 0
      ? Math.round((data.granted / (data.granted + data.refused)) * 100)
      : null;

  return (
    <div className="chat-stats">
      <div className="stats-headline">
        <span className="stats-total">{data.total.toLocaleString()}</span> applications
        {grantRate != null && (
          <span className="stats-rate">{grantRate}% grant rate</span>
        )}
      </div>
      {statusItems.length > 0 && <Bar items={statusItems} total={data.total} />}
      <div className="stats-chips">
        {data.granted != null && data.granted > 0 && (
          <span className="stats-chip" style={{ color: STATUS_COLORS.granted }}>
            {data.granted.toLocaleString()} granted
          </span>
        )}
        {data.refused != null && data.refused > 0 && (
          <span className="stats-chip" style={{ color: STATUS_COLORS.refused }}>
            {data.refused.toLocaleString()} refused
          </span>
        )}
        {data.appealed != null && data.appealed > 0 && (
          <span className="stats-chip">{data.appealed.toLocaleString()} appealed</span>
        )}
        {data.commenced != null && data.commenced > 0 && (
          <span className="stats-chip">{data.commenced.toLocaleString()} commenced</span>
        )}
      </div>
      {data.by_status && Object.keys(data.by_status).length > 2 && (
        <Breakdown label="By status" data={data.by_status} />
      )}
      {data.by_type && Object.keys(data.by_type).length > 0 && (
        <Breakdown label="By application type" data={data.by_type} />
      )}
      {data.by_year && Object.keys(data.by_year).length > 0 && (
        <Breakdown label="By year" data={data.by_year} />
      )}
      {data.by_authority && Object.keys(data.by_authority).length > 1 && (
        <Breakdown label="By council" data={data.by_authority} />
      )}
    </div>
  );
}
