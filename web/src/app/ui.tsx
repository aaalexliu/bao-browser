"use client";

import { useEffect, useState } from "react";
import { formatRelative } from "@/lib/time";

function runLabel(count: number): string {
  return count === 1 ? "1 run" : `${count} runs`;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState("light");
  useEffect(() => {
    const saved = localStorage.getItem("bao-theme") === "dark" ? "dark" : "light";
    setTheme(saved);
    document.documentElement.setAttribute("data-theme", saved);
  }, []);
  function choose(next: "light" | "dark") {
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("bao-theme", next);
  }
  return (
    <button type="button" data-testid="theme" onClick={() => choose(theme === "dark" ? "light" : "dark")}>
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}

export function LocalTime({ iso }: { iso?: string | null }) {
  const [text, setText] = useState("Not synced yet");
  useEffect(() => {
    if (!iso) {
      setText("Not synced yet");
      return;
    }
    const date = new Date(iso);
    setText(Number.isNaN(date.getTime()) ? "Not synced yet" : formatRelative(date.getTime()));
  }, [iso]);
  return <time dateTime={iso || undefined}>{text}</time>;
}

export function InstallButton({ link }: { link: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className="primary" data-testid="install" onClick={() => setOpen(true)}>Install</button>
      {open ? <p className="mono" data-testid="install-link">{link}</p> : null}
    </div>
  );
}

function LetterTile({ letter, host }: { letter: string; host: string }) {
  const hue = host.split("").reduce((sum, ch) => (sum * 33 + ch.charCodeAt(0)) % 360, 0);
  const favicon = host && host !== "127.0.0.1" && host !== "localhost"
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`
    : "";
  return (
    <span className="tile" data-letter={letter} data-domain={host} style={{ ["--tile" as string]: `hsl(${hue} 55% 46%)` }}>
      {favicon ? <img className="favicon" src={favicon} alt="" /> : null}
      <span className="mark">{letter}</span>
    </span>
  );
}

export function GalleryCard({
  href,
  id,
  title,
  summary,
  thumbnail,
  runs,
  lastGreen,
  domains,
  verified,
}: {
  href: string;
  id: string;
  title: string;
  summary: string;
  thumbnail?: string;
  runs: number;
  lastGreen: string;
  domains: string[];
  verified?: boolean;
}) {
  const letter = (title || "?").slice(0, 1).toUpperCase();
  const host = (domains[0] || "").replace(/^https?:\/\//, "").split("/")[0];
  return (
    <a className="card gallery" href={href} data-testid="listing" data-id={id}>
      <div className="thumb">
        {thumbnail
          ? <img className="shot" src={thumbnail} alt="" />
          : <LetterTile letter={letter} host={host} />}
      </div>
      <div>
        <h2>{title}</h2>
        <p className="muted">{summary}</p>
        <p className="meta">{runLabel(runs)} · last green {lastGreen}</p>
        <div className="chips">
          {domains.map((domain) => <span className="chip" key={domain}>{domain}</span>)}
          {verified ? <span className="badge">Verified</span> : null}
        </div>
      </div>
    </a>
  );
}
