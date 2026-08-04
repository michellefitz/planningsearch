import { useEffect, useState, type CSSProperties } from "react";
import { accountApi, type AreaWatch, type Me, type SavedApp, type SavedList } from "../accountApi";
import type { PointFeatureCollection } from "../api";
import { StatusBadge } from "./ResultsList";
import MapView from "./MapView";
import { PencilIcon, XIcon } from "./icons";
import { fmtDate } from "../api";
import { posthog } from "../posthog";

interface Props {
  me: Me | null;
  notice: string | null;
  onRefresh: () => Promise<Me>;
  onOpenApp: (authorityId: string, reference: string) => Promise<void>;
  onGoSearch: () => void;
  /** Show a watched area's circle on the main map. */
  onViewWatch: (watch: AreaWatch) => void;
  /** Jump to the map in watch-creation mode. */
  onAddWatch: () => void;
}

const DECIDED = new Set(["granted", "refused", "split", "decided", "withdrawn", "invalid"]);
const PENDING = new Set(["pending", "further_info"]);

function BellIcon({ on }: { on: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
      <path d="M13.7 20a2 2 0 0 1-3.4 0" />
      {!on && <path d="M4.5 3.5l15 17" />}
    </svg>
  );
}

function sortSaves(saves: SavedApp[]): SavedApp[] {
  return [...saves].sort((a, b) => {
    if (a.has_update !== b.has_update) return a.has_update ? -1 : 1;
    return b.created_at.localeCompare(a.created_at);
  });
}

function RegisterRow({
  s,
  lists,
  onOpenApp,
  onRefresh,
  index,
  updated,
}: {
  s: SavedApp;
  lists: SavedList[];
  onOpenApp: (authorityId: string, reference: string) => Promise<void>;
  onRefresh: () => Promise<Me>;
  index: number;
  updated?: boolean;
}) {
  const [alertsOn, setAlertsOn] = useState(s.alerts_enabled);
  useEffect(() => {
    setAlertsOn(s.alerts_enabled);
  }, [s.alerts_enabled]);
  const [busy, setBusy] = useState(false);

  const open = () => void onOpenApp(s.authority_id, s.planning_reference);
  // The most decision-relevant date wins the single date slot.
  const date = s.app?.decision_date
    ? `decided ${fmtDate(s.app.decision_date)}`
    : s.app?.received_date
      ? `received ${fmtDate(s.app.received_date)}`
      : null;

  return (
    <div
      className={`reg-row${updated ? " reg-row-updated" : ""}`}
      role="button"
      tabIndex={0}
      style={{ "--i": index } as CSSProperties}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      <span className="reg-status">
        {s.app ? (
          <StatusBadge status={s.app.status} label={s.app.status_label} />
        ) : (
          <span className="reg-gone">Not in dataset</span>
        )}
      </span>
      <span className="reg-main">
        <strong className="reg-address">{s.app?.address_text ?? s.planning_reference}</strong>
        {s.has_update && !updated && <span className="badge-updated">Updated</span>}
        {s.latest_event_summary && (
          <span className="reg-latest">
            {s.latest_event_summary}
            {s.latest_event_at && ` · ${fmtDate(s.latest_event_at.slice(0, 10))}`}
          </span>
        )}
      </span>
      <span className="reg-meta">
        <span className="ref">{s.planning_reference}</span>
        {date && <span className="reg-date">{date}</span>}
      </span>
      <span className="reg-actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className={`saved-bell${alertsOn ? " saved-bell-on" : ""}`}
          title={alertsOn ? "Alerts on — click to turn off" : "Alerts off — click to turn on"}
          aria-pressed={alertsOn}
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
          <BellIcon on={alertsOn} />
        </button>
        {lists.length > 0 && (
          <select
            className="saved-list-select"
            value=""
            aria-label="Add to list"
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
            <option value="">List…</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        )}
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
          <XIcon />
        </button>
      </span>
    </div>
  );
}

function ListSectionHead({
  list,
  count,
  onRefresh,
}: {
  list: SavedList;
  count: number;
  onRefresh: () => Promise<Me>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(list.name);
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div className="reg-section-head">
        <p className="list-confirm">
          Delete “{list.name}”? Its applications stay saved.
          <button
            type="button"
            className="list-confirm-del"
            onClick={async () => {
              await accountApi.deleteList(list.id);
              await onRefresh();
            }}
          >
            Delete list
          </button>
          <button
            type="button"
            className="list-confirm-keep"
            onClick={() => setConfirming(false)}
          >
            Keep list
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="reg-section-head">
      {editing ? (
        <form
          className="list-rename-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            await accountApi.updateList(list.id, { name: name.trim() });
            setEditing(false);
            await onRefresh();
          }}
        >
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }}
          />
        </form>
      ) : (
        <h3>
          {list.name} <span className="reg-count">{count}</span>
        </h3>
      )}
      <div className="list-actions">
        <button
          type="button"
          className={`list-bell${list.alerts_enabled ? " list-bell-on" : ""}`}
          title={list.alerts_enabled ? "List alerts on" : "List alerts off"}
          aria-pressed={list.alerts_enabled}
          onClick={async () => {
            await accountApi.updateList(list.id, { alerts_enabled: !list.alerts_enabled });
            await onRefresh();
          }}
        >
          <BellIcon on={list.alerts_enabled} />
        </button>
        <button
          type="button"
          className="list-edit-btn"
          title="Rename list"
          onClick={() => { setName(list.name); setEditing(true); }}
        >
          <PencilIcon />
        </button>
        <button
          type="button"
          className="list-delete-btn"
          title="Delete list"
          onClick={() => setConfirming(true)}
        >
          <XIcon />
        </button>
      </div>
    </div>
  );
}

export default function AccountPanel({ me, notice, onRefresh, onOpenApp, onGoSearch, onViewWatch, onAddWatch }: Props) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [view, setView] = useState<"register" | "map">("register");
  const [mapList, setMapList] = useState<number | "all">("all");
  const [newListName, setNewListName] = useState("");
  const [creatingList, setCreatingList] = useState(false);

  if (!me) return <div className="account-panel"><p className="account-muted">Loading your applications…</p></div>;

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
                  posthog.capture("sign_in_link_requested");
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
  const updatedSaves = sortSaves(saves.filter((s) => s.has_update));

  // Grouping: one section per list (a save can appear in several), then the
  // rest under "Everything else". No lists → one flat register, no headers.
  const inAnyList = new Set(lists.flatMap((l) => l.item_ids));
  const unfiled = sortSaves(saves.filter((s) => !inAnyList.has(s.id)));
  const groups = lists.map((l) => ({
    list: l,
    items: sortSaves(saves.filter((s) => l.item_ids.includes(s.id))),
  }));

  // Map view can be narrowed to one list; fall back to all if it was deleted.
  const mapListObj = mapList === "all" ? null : lists.find((l) => l.id === mapList) ?? null;
  const mapSource = mapListObj ? saves.filter((s) => mapListObj.item_ids.includes(s.id)) : saves;
  const mappable = mapSource.filter((s) => s.app && s.app.lat != null && s.app.lng != null);
  const unmappedCount = mapSource.length - mappable.length;

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

  // Row stagger index across the whole page, so sections cascade as one.
  let rowIndex = 0;

  return (
    <div className="account-panel">
      <div className="reg-head">
        <h2>Your saved applications</h2>
        {saves.length > 0 && (
          <p className="reg-statline">
            <b>{tracked}</b> tracked
            <span className="reg-sep">·</span>
            <b>{pending}</b> pending
            <span className="reg-sep">·</span>
            <b>{decided}</b> decided
            {updatedSaves.length > 0 && (
              <>
                <span className="reg-sep">·</span>
                <span className="reg-stat-live"><b>{updatedSaves.length}</b> updated</span>
              </>
            )}
          </p>
        )}
      </div>

      {saves.length === 0 ? (
        <div className="account-empty">
          <strong>Nothing saved yet</strong>
          <p>Star any application in Search and it'll live here — with alerts when it changes.</p>
          <button type="button" onClick={onGoSearch}>Search your area</button>
        </div>
      ) : (
        <>
          {updatedSaves.length > 0 ? (
            <section className="reg-updates" aria-label="Updated applications">
              <h3>Since you last looked</h3>
              {updatedSaves.map((s) => (
                <RegisterRow
                  key={`u${s.id}`}
                  s={s}
                  lists={lists}
                  onOpenApp={onOpenApp}
                  onRefresh={onRefresh}
                  index={rowIndex++}
                  updated
                />
              ))}
            </section>
          ) : (
            <p className="reg-steady">
              Nothing new since you last looked — we'll email you the day something changes.
            </p>
          )}

          <div className="account-view-toggle">
            <div className="view-seg">
              <button
                type="button"
                className={view === "register" ? "on" : ""}
                onClick={() => setView("register")}
              >
                Register
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

          {view === "map" ? (
            <>
              {lists.length > 0 && (
                <div className="map-list-chips" role="group" aria-label="Filter map by list">
                  <button
                    type="button"
                    className={mapList === "all" ? "on" : ""}
                    onClick={() => setMapList("all")}
                  >
                    All saved
                  </button>
                  {lists.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      className={mapList === l.id ? "on" : ""}
                      onClick={() => setMapList(l.id)}
                    >
                      {l.name}
                    </button>
                  ))}
                </div>
              )}
              {mappable.length === 0 ? (
                <div className="account-empty">
                  <strong>No mapped locations</strong>
                  <p>None of these applications have coordinates to show on a map.</p>
                </div>
              ) : (
                <div className="account-map-wrap">
                  <MapView
                    data={mapGeoJson}
                    polygons={null}
                    selectedId={null}
                    hoveredId={null}
                    onSelect={handleMapSelect}
                    onBoundsChange={() => {}}
                  />
                </div>
              )}
              {unmappedCount > 0 && (
                <p className="account-map-note">
                  {unmappedCount} without map location{unmappedCount === 1 ? "" : "s"}
                </p>
              )}
            </>
          ) : (
            <div className="reg-body">
              {groups.map(({ list, items }) => (
                <section key={list.id} aria-label={list.name}>
                  <ListSectionHead list={list} count={items.length} onRefresh={onRefresh} />
                  {items.length === 0 ? (
                    <p className="reg-list-empty">Nothing in this list yet — add applications from any row.</p>
                  ) : (
                    items.map((s) => (
                      <RegisterRow
                        key={`${list.id}-${s.id}`}
                        s={s}
                        lists={lists}
                        onOpenApp={onOpenApp}
                        onRefresh={onRefresh}
                        index={rowIndex++}
                      />
                    ))
                  )}
                </section>
              ))}

              {unfiled.length > 0 && (
                <section aria-label={lists.length > 0 ? "Everything else" : "Saved applications"}>
                  {lists.length > 0 && (
                    <div className="reg-section-head">
                      <h3>
                        Everything else <span className="reg-count">{unfiled.length}</span>
                      </h3>
                    </div>
                  )}
                  {unfiled.map((s) => (
                    <RegisterRow
                      key={s.id}
                      s={s}
                      lists={lists}
                      onOpenApp={onOpenApp}
                      onRefresh={onRefresh}
                      index={rowIndex++}
                    />
                  ))}
                </section>
              )}

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
                  <button type="submit">Create list</button>
                </form>
              ) : (
                <button
                  type="button"
                  className="list-new-btn"
                  onClick={() => setCreatingList(true)}
                >
                  + New list
                </button>
              )}

              {saves.length <= 5 && (
                <p className="reg-teach">
                  Star more applications in Search to build out your register.
                </p>
              )}
            </div>
          )}
        </>
      )}

      <section className="watch-section" aria-label="Watched areas">
        <div className="reg-section-head">
          <h3>
            Watched areas{" "}
            {(me.watches?.length ?? 0) > 0 && <span className="reg-count">{me.watches!.length}</span>}
          </h3>
        </div>
        {(me.watches?.length ?? 0) === 0 ? (
          <div className="account-empty">
            <strong>No areas watched yet</strong>
            <p>
              Pick a point on the map and a radius, and we'll email you the day anything new lands
              inside it — planning applications, An Coimisiún Pleanála cases, or work commencing.
            </p>
            <button type="button" onClick={onAddWatch}>Watch an area on the map</button>
          </div>
        ) : (
          me.watches!.map((w) => (
            <div key={w.id} className="watch-row">
              <button type="button" className="watch-row-main" onClick={() => onViewWatch(w)} title="Show on the map">
                <strong>{w.name}</strong>
                <span className="watch-row-sub">
                  within {w.radius_m < 1000 ? `${w.radius_m} m` : `${w.radius_m / 1000} km`} · added {fmtDate(w.created_at.slice(0, 10))}
                </span>
              </button>
              <button
                type="button"
                className={`saved-bell${w.alerts_enabled ? " saved-bell-on" : ""}`}
                aria-pressed={w.alerts_enabled}
                title={w.alerts_enabled ? "Alerts on — click to pause" : "Alerts paused — click to resume"}
                onClick={async () => {
                  await accountApi.updateWatch(w.id, { alerts_enabled: !w.alerts_enabled });
                  await onRefresh();
                }}
              >
                <BellIcon on={w.alerts_enabled} />
              </button>
              <button
                type="button"
                className="watch-delete"
                title="Stop watching this area"
                onClick={async () => {
                  await accountApi.deleteWatch(w.id);
                  await onRefresh();
                }}
              >
                <XIcon size={13} />
              </button>
            </div>
          ))
        )}
        {(me.watches?.length ?? 0) > 0 && (
          <button type="button" className="list-new-btn" onClick={onAddWatch}>
            + Watch a new area
          </button>
        )}
      </section>
    </div>
  );
}
