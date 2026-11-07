/** Why an inbound email looks machine-sent. Stored on the message, so a human can see why. */
export type AutomatedReason =
  | "auto_submitted"
  | "precedence"
  | "mailing_list"
  | "auto_response_suppress"
  | "system_sender"
  | "delivery_report";

export interface Header {
  /** Lowercased header name, as postal-mime gives it. */
  key: string;
  value: string;
}

const systemSenders = /^(mailer-daemon|postmaster|mail-daemon)@/i;

/**
 * Spots out-of-office replies, bounces and list mail from headers alone. Such mail must never
 * get an AI reply: it costs a draft, and two auto-responders replying to each other loop
 * forever. Headers can be forged, but forging one only stops a draft, which is the safe side.
 */
export function detectAutomated(
  headers: Header[],
  fromAddress: string | null,
): AutomatedReason | null {
  const get = (name: string) =>
    headers
      .filter((h) => h.key === name)
      .map((h) => h.value.trim().toLowerCase())
      .filter((v) => v !== "");

  // RFC 3834: any value other than "no" means a machine sent it.
  if (get("auto-submitted").some((v) => !/^no\b/.test(v))) return "auto_submitted";
  if (get("precedence").some((v) => /^(bulk|junk|list|auto_reply)\b/.test(v))) return "precedence";
  if (get("list-id").length > 0 || get("list-unsubscribe").length > 0) return "mailing_list";
  if (get("x-auto-response-suppress").length > 0) return "auto_response_suppress";
  if (fromAddress && systemSenders.test(fromAddress)) return "system_sender";
  if (get("content-type").some((v) => /^multipart\/report\b/.test(v))) return "delivery_report";
  return null;
}

/**
 * Headers every outbound reply carries. Replies are human-approved, so they do not claim
 * `Auto-Submitted`, but they ask Exchange not to answer them with an out-of-office.
 */
export const outboundReplyHeaders = { "X-Auto-Response-Suppress": "All" } as const;
