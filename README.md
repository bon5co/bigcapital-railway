# bigcapital-railway

Wrapper image that lets [BigCapital](https://github.com/bigcapitalhq/bigcapital) (AGPL-3.0) run as a Railway template.

`ghcr.io/bon5co/bigcapital-railway` wraps `bigcapitalhq/server` and `bigcapitalhq/webapp` 0.25.48: it copies the built web app out of
the official webapp image, runs the database migrations, starts the API on a private port with sign-up closed to everyone except
`ADMIN_EMAIL`, creates that owner account, and only then opens the public port, where a small front door serves the web app and
forwards `/api` to the server (the job upstream's Envoy proxy does).

The Railway template that uses it is published from the `bon5co` workspace; this repository holds only the image.
