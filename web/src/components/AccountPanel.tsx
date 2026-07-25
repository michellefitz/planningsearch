import { useEffect, useState } from "react";
import { accountApi, type Me, type SavedApp, type SavedList } from "../accountApi";
import type { PointFeatureCollection } from "../api";
import { StatusBadge } from "./ResultsList";
import MapView from "./MapView";

interface Props {
  me: Me | null;
  notice: string | null;
  onRefresh: () => Promise<Me>;
  onOpenApp: (authorityId: string, reference: string) => Promise<void>;
  onGoSearch: () => void;
}

const DECIDED = new Set(["granted", "refused", "split", "decided", "withdrawn", "invalid"]);
const PENDING = new Set(["pending", "further_info"]);

function sortSaves(saves: SavedApp[]): SavedApp[] {
  return [...saves].sort((a, b) => {
    if (a.has_update !== b.has_update) return a.has_update ? -1 : 1;
    return b.created_at.localeCompare(a.created_at);
  });
}

function SavedCard({
  s,
  lists,
  onOpenApp,
  onRefresh,
}: {
  s: SavedApp;
  lists: SavedList[];
  onOpenApp: (authorityId: string, reference: string) => Promise<void>;
  onRefresh: () => Promise<Me>;
}) {
  const [alertsOn, setAlertsOn] = useState(s.alerts_enabled);
  useEffect(() => {
    setAlertsOn(s.alerts_enabled);
  }, [s.alerts_enabled]);
  const [busy, setBusy] = useState(false);

  const handleClick = () => {
    void onOpenApp(s.authority_id, s.planning_reference);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <div
      className="saved-card"
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKey}
    >
      {/* The address gets the card's full width; "Updated" joins the status
          row below rather than squeezing the address into extra lines. */}
      <div className="saved-card-top">
        <strong className="saved-card-address">
          {s.app?.address_text ?? s.planning_reference}
        </strong>
      </div>

      {s.app ? (
        <div className="saved-card-status">
          <StatusBadge status={s.app.status} label={s.app.status_label} />
          {s.has_update && <span className="badge-updated">Updated</span>}
        </div>
      ) : (
        <p className="saved-card-gone">No longer in the dataset</p>
      )}

      <p className="saved-card-ref">
        <span className="ref">{s.planning_reference}</span>
        {s.app?.received_date && <span className="saved-card-date"> · received {s.app.received_date}</span>}
        {s.app?.decision_date && <span className="saved-card-date"> · decided {s.app.decision_date}</span>}
      </p>

      <div className="saved-card-actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className={`saved-bell${alertsOn ? " saved-bell-on" : ""}`}
          title={alertsOn ? "Alerts on — click to turn off" : "Alerts off — click to turn on"}
          disabled={busy}
          onClick={async (e) => {
            e.stopPropagation();
            const next = !alertsOn;
            setAlertsOn(next);
            try {
              await accountApi.updateSave(s.id, { alerts_enabled: next });
            } catch {
              setAlertsOn(!next);
            }
          }}
        >
          {alertsOn ? "\u{1F514}" : "\u{1F515}"}
        </button>

        <select
          className="saved-list-select"
          value=""
          onClick={(e) => e.stopPropagation()}
          onChange={async (e) => {
            e.stopPropagation();
            const listId = Number(e.target.value);
            if (!listId) return;
            setBusy(true);
            try {
              await accountApi.addToList(listId, s.id);
              await onRefresh();
            } finally {
              setBusy(false);
            }
          }}
        >
          <option value="">Add to list…</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>

        <button
          type="button"
          className="saved-remove"
          title="Remove from saved"
          disabled={busy}
          onClick={async (e) => {
            e.stopPropagation();
            setBusy(true);
            try {
              await accountApi.unsave(s.id);
              await onRefresh();
            } finally {
              setBusy(false);
            }
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function CompactRow({
  s,
  onOpenApp,
}: {
  s: SavedApp;
  onOpenApp: (authorityId: string, reference: string) => Promise<void>;
}) {
  return (
    <button
      type="button"
      className="compact-row"
      onClick={() => void onOpenApp(s.authority_id, s.planning_reference)}
    >
      <strong>{s.app?.address_text ?? s.planning_reference}</strong>
      {s.app ? (
        <StatusBadge status={s.app.status} label={s.app.status_label} />
      ) : (
        <span className="saved-card-gone">Not in dataset</span>
      )}
      {s.has_update && <span className="badge-updated">Updated</span>}
      <span className="ref compact-ref">{s.planning_reference}</span>
    </button>
  );
}

export default function AccountPanel({ me, notice, onRefresh, onOpenApp, onGoSearch }: Props) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [view, setView] = useState<"cards" | "list" | "map">("cards");
  const [activeList, setActiveList] = useState<number | "all">("all");
  const [newListName, setNewListName] = useState("");
  const [creatingList, setCreatingList] = useState(false);
  const [editingListId, setEditingListId] = useState<number | null>(null);
  const [editingListName, setEditingListName] = useState("");

  if (!me) return <div className="account-panel"><p className="account-muted">Loading…</p></div>;

  if (!me.user) {
    return (
      <div className="account-panel account-signin">
        <div className="signin-card">
          <h2>Your applications, watched</h2>
          <p>
            Save any planning application, organise them into lists, and get an email
            the day something changes — a decision, an appeal, work starting on site.
          </p>
          {notice && <p className="signin-notice">{notice}</p>}
          {state === "sent" ? (
            <div className="signin-sent">
              <strong>Check your inbox</strong>
              <p>We've sent a sign-in link to {email}. It expires in 15 minutes.</p>
            </div>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setState("sending");
                try {
                  await accountApi.requestLink(email);
                  setState("sent");
                } catch {
                  setState("error");
                }
              }}
            >
              <input
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
              <button type="submit" disabled={state === "sending"}>
                {state === "sending" ? "Sending…" : "Email me a sign-in link"}
              </button>
              {state === "error" && (
                <p className="signin-notice">Couldn't send just now — try again in a moment.</p>
              )}
            </form>
          )}
          <p className="signin-fine">No password. First sign-in creates your account.</p>
        </div>
      </div>
    );
  }

  const { saves, lists } = me;
  const tracked = saves.length;
  const pending = saves.filter((s) => s.app && PENDING.has(s.app.status)).length;
  const decided = saves.filter((s) => s.app && DECIDED.has(s.app.status)).length;
  const updated = saves.filter((s) => s.has_update).length;

  const activeListObj = activeList === "all" ? null : lists.find((l) => l.id === activeList) ?? null;
  const activeIds = activeListObj ? new Set(activeListObj.item_ids) : null;
  const filtered = activeIds ? saves.filter((s) => activeIds.has(s.id)) : saves;
  const sorted = sortSaves(filtered);

  const mappable = sorted.filter((s) => s.app && s.app.lat != null && s.app.lng != null);
  const unmappedCount = sorted.length - mappable.length;

  const mapGeoJson: PointFeatureCollection = {
    type: "FeatureCollection",
    features: mappable.map((s) => ({
      type: "Feature" as const,
      geometry: {
        type: "Point" as const,
        coordinates: [s.app!.lng!, s.app!.lat!] as [number, number],
      },
      properties: {
        id: s.app!.id,
        reference: s.app!.planning_reference,
        status: s.app!.status,
        authority_id: s.app!.authority_id,
        address: s.app!.address_text,
        is_domestic_guess: s.app!.is_domestic_guess,
      },
    })),
  };

  const handleMapSelect = (id: number) => {
    const match = saves.find((s) => s.app?.id === id);
    if (match) void onOpenApp(match.authority_id, match.planning_reference);
  };

  return (
    <div className="account-panel">
      {/* Identity and sign-out live in the app's top bar, not in here. */}
      <div className="account-head">
        <h2>Saved applications</h2>
      </div>

      {saves.length === 0 ? (
        <div className="account-empty">
          <strong>Nothing saved yet</strong>
          <p>Star any application in Search and it'll live here — with alerts when it changes.</p>
          <button type="button" onClick={onGoSearch}>Search your area</button>
        </div>
      ) : (
        <>
          {/* Req 1: Stat row */}
          <div className="account-stats">
            <div className="stat-tile">
              <strong>{tracked}</strong>
              <span>tracked</span>
            </div>
            <div className="stat-tile">
              <strong>{pending}</strong>
              <span>pending decision</span>
            </div>
            <div className="stat-tile">
              <strong>{decided}</strong>
              <span>decided</span>
            </div>
            <div className="stat-tile">
              <strong>{updated}</strong>
              <span>with updates</span>
            </div>
          </div>

          {/* Req 2: View toggle + Req 4: List sidebar */}
          <div className="account-layout">
            <div className="account-lists">
              <button
                type="button"
                className={activeList === "all" ? "list-active" : ""}
                onClick={() => setActiveList("all")}
              >
                All saved <span className="list-count">{saves.length}</span>
              </button>
              {lists.map((l) => (
                <div key={l.id} className="list-row">
                  {editingListId === l.id ? (
                    <form
                      className="list-rename-form"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (!editingListName.trim()) return;
                        await accountApi.updateList(l.id, { name: editingListName.trim() });
                        setEditingListId(null);
                        await onRefresh();
                      }}
                    >
                      <input
                        type="text"
                        value={editingListName}
                        onChange={(e) => setEditingListName(e.target.value)}
                        autoFocus
                        onBlur={() => setEditingListId(null)}
                        onKeyDown={(e) => { if (e.key === "Escape") setEditingListId(null); }}
                      />
                    </form>
                  ) : (
                    <button
                      type="button"
                      className={activeList === l.id ? "list-active" : ""}
                      onClick={() => setActiveList(l.id)}
                    >
                      {l.name} <span className="list-count">{l.item_ids.length}</span>
                    </button>
                  )}
                  <div className="list-actions">
                    <button
                      type="button"
                      className={`list-bell${l.alerts_enabled ? " list-bell-on" : ""}`}
                      title={l.alerts_enabled ? "List alerts on" : "List alerts off"}
                      onClick={async () => {
                        await accountApi.updateList(l.id, { alerts_enabled: !l.alerts_enabled });
                        await onRefresh();
                      }}
                    >
                      {l.alerts_enabled ? "\u{1F514}" : "\u{1F515}"}
                    </button>
                    <button
                      type="button"
                      className="list-edit-btn"
                      title="Rename list"
                      onClick={() => { setEditingListId(l.id); setEditingListName(l.name); }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="list-delete-btn"
                      title="Delete list"
                      onClick={async () => {
                        await accountApi.deleteList(l.id);
                        if (activeList === l.id) setActiveList("all");
                        await onRefresh();
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}

              {creatingList ? (
                <form
                  className="list-new-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!newListName.trim()) return;
                    await accountApi.createList(newListName.trim());
                    setNewListName("");
                    setCreatingList(false);
                    await onRefresh();
                  }}
                >
                  <input
                    type="text"
                    placeholder="List name"
                    value={newListName}
                    onChange={(e) => setNewListName(e.target.value)}
                    autoFocus
                    onKeyDown={(e) => { if (e.key === "Escape") setCreatingList(false); }}
                  />
                  <button type="submit">Add</button>
                </form>
              ) : (
                <button
                  type="button"
                  className="list-new-btn"
                  onClick={() => setCreatingList(true)}
                >
                  + New list…
                </button>
              )}
            </div>

            <div className="account-main">
              <div className="account-view-toggle">
                <div className="view-seg">
                  <button
                    type="button"
                    className={view === "cards" ? "on" : ""}
                    onClick={() => setView("cards")}
                  >
                    Cards
                  </button>
                  <button
                    type="button"
                    className={view === "list" ? "on" : ""}
                    onClick={() => setView("list")}
                  >
                    List
                  </button>
                  <button
                    type="button"
                    className={view === "map" ? "on" : ""}
                    onClick={() => setView("map")}
                  >
                    Map
                  </button>
                </div>
              </div>

              {sorted.length === 0 && activeListObj ? (
                <div className="account-empty">
                  <strong>Nothing in this list yet</strong>
                  <p>Add saved applications to it from their cards.</p>
                </div>
              ) : view === "map" ? (
                mappable.length === 0 ? (
                  <div className="account-empty">
                    <strong>No mapped locations</strong>
                    <p>None of these applications have coordinates to show on a map.</p>
                  </div>
                ) : (
                  <>
                    <div className="account-map-wrap">
                      <MapView
                        data={mapGeoJson}
                        selectedId={null}
                        hoveredId={null}
                        onSelect={handleMapSelect}
                        onBoundsChange={() => {}}
                      />
                    </div>
                    {unmappedCount > 0 && (
                      <p className="account-map-note">
                        {unmappedCount} without map location{unmappedCount === 1 ? "" : "s"}
                      </p>
                    )}
                  </>
                )
              ) : view === "cards" ? (
                <div className="saved-grid">
                  {sorted.map((s) => (
                    <SavedCard
                      key={s.id}
                      s={s}
                      lists={lists}
                      onOpenApp={onOpenApp}
                      onRefresh={onRefresh}
                    />
                  ))}
                </div>
              ) : (
                <div className="compact-list">
                  {sorted.map((s) => (
                    <CompactRow key={s.id} s={s} onOpenApp={onOpenApp} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
