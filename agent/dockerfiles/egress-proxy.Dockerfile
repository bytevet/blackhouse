# Blackhouse egress proxy.
#
# The only container with a route off the internal agent network, so it is kept
# as small as it can be: a stock Node base, two .mjs files, no dependencies, no
# package.json, no build step. Nothing here executes model-authored code.
#
# Built by `server/egress/proxy-manager.ts#ensureProxyImage` with the repo root
# as the build context, matching how the agent images resolve
# `COPY agent/...` paths.

FROM node:24-alpine

# Tini gives the proxy a real init so that a `docker stop` reaches Node as
# SIGTERM instead of being swallowed by PID 1 semantics.
RUN apk add --no-cache tini

COPY agent/egress-proxy /opt/blackhouse/egress-proxy

# Unprivileged: the proxy listens on 3128, well above the privileged range, and
# has no reason to own anything on disk.
USER node

ENV EGRESS_PROXY_PORT=3128
EXPOSE 3128

# Reports policy source and rule count — enough to tell "running but has no
# policy" (denies everything) from "running and enforcing".
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.EGRESS_PROXY_PORT||3128)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/opt/blackhouse/egress-proxy/proxy.mjs"]
