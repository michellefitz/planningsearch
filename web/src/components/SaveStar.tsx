import { useState } from "react";

interface Props {
  saved: boolean;
  onToggle: () => void;
  label?: boolean;
  inline?: boolean;
}

export default function SaveStar({ saved, onToggle, label, inline }: Props) {
  // Pop only on the act of saving — never on stars that render already filled.
  const [pop, setPop] = useState(false);
  const toggle = () => {
    if (!saved) setPop(true);
    onToggle();
  };
  const star = (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"
        fill={saved ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );

  if (inline) {
    return (
      <>
        {star}
        {label ? <em>{saved ? "Saved" : "Save"}</em> : null}
      </>
    );
  }

  return (
    <span
      role="button"
      tabIndex={0}
      aria-pressed={saved}
      aria-label={saved ? "Remove from saved" : "Save application"}
      className={`save-star ${saved ? "save-star-on" : ""}${pop ? " save-star-pop" : ""}`}
      onAnimationEnd={() => setPop(false)}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        toggle();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.stopPropagation();
          e.preventDefault();
          toggle();
        }
      }}
    >
      {star}
      {label ? <em>{saved ? "Saved" : "Save"}</em> : null}
    </span>
  );
}
