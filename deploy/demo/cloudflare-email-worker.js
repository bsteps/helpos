// Cloudflare Email Routing worker: forwards each inbound email, as raw MIME, to the demo's
// inbound webhook. Give the worker two secrets: HELPOS_INBOUND_URL
// (https://<domain>/v1/inbound/email) and HELPOS_INBOUND_SECRET (the server's value).
// Only the forwarding runs on Cloudflare. Any provider that can POST raw MIME works the same way.
export default {
  async email(message, env) {
    const res = await fetch(env.HELPOS_INBOUND_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.HELPOS_INBOUND_SECRET}`,
        "content-type": "message/rfc822",
      },
      body: message.raw,
    });
    // 404: no workspace has this address. Bounce it, so the sender knows.
    if (res.status === 404) message.setReject("Unknown support address");
    // Any other failure: throw, so the email is retried instead of dropped.
    else if (!res.ok) throw new Error(`inbound webhook answered ${res.status}`);
  },
};
