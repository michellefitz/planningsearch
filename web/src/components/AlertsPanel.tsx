import {
  accountApi,
  fmtRadius,
  watchKinds,
  WATCH_KIND_LABELS,
  type AreaWatch,
  type Me,
} from "../accountApi";
import { fmtDate } from "../api";
import { BellIcon } from "./icons";
import { RowMenu } from "./RowMenu";
import SignInCard from "./SignInCard";

/**
 * Watched areas — the alerts attached to a place you drew, rather than to
 * something you saved.
 *
 * That distinction is the whole reason this is its own screen. An alert on a
 * saved application or a saved list is a property of the thing it is attached
 * to, so its bell stays on that row over in Saved; an area watch is attached
 * to nothing but a point and a radius, and has nowhere else to live. Keeping
 * both in one dashboard meant drawing an area took over the map from a screen
 * that had no map on it.
 */
export default function AlertsPanel({
  me,
  notice,
  onRefresh,
  onViewWatch,
  onAddWatch,
}: {
  me: Me | null;
  notice: string | null;
  onRefresh: () => Promise<Me>;
  onViewWatch: (watch: AreaWatch) => void;
  onAddWatch: () => void;
}) {
  if (!me) return <div className="account-panel"><p className="account-muted">Loading your alerts…</p></div>;

  if (!me.user) {
    return (
      <SignInCard
        headline="Alerts for anywhere you care about"
        blurb="Draw a circle on the map, choose what you want to hear about — new applications, decisions, appeals, work starting on site — and we'll email you the day one lands inside it."
        notice={notice}
      />
    );
  }

  const watches = me.watches ?? [];
  return (
    <div className="account-panel">
      <div className="reg-head">
        <h2>Watched areas</h2>
        {watches.length > 0 && (
          <p className="reg-statline">
            <b>{watches.length}</b> {watches.length === 1 ? "area" : "areas"}
            <span className="reg-sep">·</span>
            <b>{watches.filter((w) => w.alerts_enabled).length}</b> active
          </p>
        )}
      </div>
      {watches.length === 0 ? (
        <div className="account-empty">
          <strong>No areas watched yet</strong>
          <p>
            Pick a point on the map and a radius, choose what you want to hear about — new
            applications, decisions, appeals, work starting on site — and we'll email you the day
            one of them lands inside it.
          </p>
          <button type="button" onClick={onAddWatch}>Watch an area on the map</button>
        </div>
      ) : (
        watches.map((w) => (
          <div key={w.id} className="watch-row">
            <button type="button" className="watch-row-main" onClick={() => onViewWatch(w)} title="Show on the map and edit">
              <strong>{w.name}</strong>
              <span className="watch-row-sub">
                within {fmtRadius(w.radius_m)} · added {fmtDate(w.created_at.slice(0, 10))}
              </span>
              {/* What this area will actually tell you. It used to say
                  nothing, so the only way to find out was to wait for an
                  email — or not get one and wonder why. */}
              <span className="watch-row-kinds">
                {watchKinds(w).map((k) => (
                  <span className="watch-kind-tag" key={k}>
                    {WATCH_KIND_LABELS[k].label}
                  </span>
                ))}
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
            {/* Same reasoning as the saved rows: an X that permanently
                deletes must not look like an X that closes something. */}
            <RowMenu label={`Actions for ${w.name}`}>
              {(close) => (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="row-menu-item"
                    onClick={() => {
                      close();
                      onViewWatch(w);
                    }}
                  >
                    Show on the map and edit
                  </button>
                  <span className="row-menu-sep" />
                  <button
                    type="button"
                    role="menuitem"
                    className="row-menu-item row-menu-danger"
                    onClick={async () => {
                      close();
                      await accountApi.deleteWatch(w.id);
                      await onRefresh();
                    }}
                  >
                    Stop watching this area
                  </button>
                </>
              )}
            </RowMenu>
          </div>
        ))
      )}
      {watches.length > 0 && (
        <button type="button" className="list-new-btn" onClick={onAddWatch}>
          + Watch a new area
        </button>
      )}
    </div>
  );
}
