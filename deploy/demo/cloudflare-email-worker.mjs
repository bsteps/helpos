// Cloudflare Email Routing worker: forwards each inbound email, as raw MIME, to the demo's
// inbound webhook. Give the worker two secrets: HELPOS_INBOUND_URL
// (https://<domain>/v1/inbound/email) and HELPOS_INBOUND_SECRET (the server's value).
// Only the forwarding runs on Cloudflare. Any provider that can POST raw MIME works the same way.
//
// Workspaces on the demo use addresses on the demo domain (acme@<domain>), because the server
// sends replies from the mailbox address, and only the demo domain can pass SPF/DKIM. Partners
// auto-forward their own inbox here, but a forwarded email still says `To: support@acme.com`.
// So the worker puts the address it was really delivered to on top, as `Delivered-To`, which
// the server checks first. scripts/smoke-demo.sh runs this exact code.

/** The email with `Delivered-To: <address>` added as its first header. */
export function withDeliveredTo(address, raw) {
  // The address comes from the mail envelope. Refuse anything that could inject a header.
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(address)) throw new Error("unusable recipient address");
  return new Blob([`Delivered-To: ${address}\r\n`, raw]);
}

export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const res = await fetch(env.HELPOS_INBOUND_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.HELPOS_INBOUND_SECRET}`,
        "content-type": "message/rfc822",
      },
      body: withDeliveredTo(message.to, raw),
    });
    // 404: no workspace has this address. Bounce it, so the sender knows.
    if (res.status === 404) message.setReject("Unknown support address");
    // Any other failure: throw, so the email is retried instead of dropped.
    else if (!res.ok) throw new Error(`inbound webhook answered ${res.status}`);
  },
};
