import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The email's own policy, on top of the dashboard's (a `srcdoc` frame inherits that one too):
 * nothing loads from anywhere, not even from us. Only inlined images and inline styles.
 */
const frameCsp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

/** Matches the dashboard's body text, so an email reads like the rest of the page. */
const bodyStyle = [
  "margin:0",
  "font:14px/1.6 'Geist Variable',ui-sans-serif,system-ui,sans-serif",
  "color:#0b0b0b",
  "overflow-wrap:anywhere",
].join(";");

function frameDocument(html: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${frameCsp}">` +
    `</head><body style="${bodyStyle}">${html}</body></html>`
  );
}

export interface EmailFrameProps {
  /** Sanitised by the server already. This frame is the second and third layer, not the first. */
  html: string;
  /** Names the frame for screen readers, e.g. "Email from jane@customer.test". */
  title: string;
  className?: string;
}

/**
 * Shows customer HTML. The sandbox has no `allow-scripts`, so nothing in it can run, whatever
 * got past the sanitiser and the CSP. `allow-same-origin` only lets this page measure the
 * frame's height; without scripts inside, it gives the email nothing. Links open in a new tab
 * (`allow-popups`), outside the sandbox so the site works, and never with a referrer.
 */
export function EmailFrame({ html, title, className }: EmailFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(80);

  const measure = useCallback(() => {
    const body = ref.current?.contentDocument?.documentElement;
    if (body) setHeight(Math.ceil(body.scrollHeight));
  }, []);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  return (
    <iframe
      ref={ref}
      title={title}
      srcDoc={frameDocument(html)}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      onLoad={measure}
      style={{ height }}
      className={cn("block w-full border-0 bg-transparent", className)}
    />
  );
}
