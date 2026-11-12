# Local HTTPS test fixture

This certificate and private key are public test data, used only by the loopback HTTPS server in `https.test.ts`. They must never identify a deployed service.

The self-signed certificate names `docs.test` only. Generate a replacement with OpenSSL:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout https-test-key.pem -out https-test-cert.pem -days 36500 -subj '/CN=docs.test' -addext 'subjectAltName=DNS:docs.test'
```

The default test trusts nothing extra. Two tests wrap the real `https.request` to add only this certificate as a request-local CA. Certificate and hostname verification remain enabled. Each test restores the wrapper and closes its server.
