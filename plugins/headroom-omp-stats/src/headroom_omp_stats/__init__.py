"""Headroom proxy extension: record /v1/compress outcomes into proxy stats.

Upstream's compression-only endpoint (used by SDK clients such as the OMP
headroom extension) computes savings but never calls the request-outcome
funnel, so /stats, /dashboard, the persisted savings history and the
"Proxy $ Saved" tile all stay at zero for SDK-only deployments.

This extension wraps ``proxy.handle_compress`` on the live proxy instance
(the /v1/compress route resolves the attribute per request) and emits a
``RequestOutcome`` for every successful compression, mirroring what the
passthrough handlers do.

Enable with ``HEADROOM_PROXY_EXTENSIONS=omp_stats``.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

logger = logging.getLogger("headroom.omp_stats")

_PROVIDER_PREFIXES = (
    ("claude", "anthropic"),
    ("gpt", "openai"),
    ("o1", "openai"),
    ("o3", "openai"),
    ("o4", "openai"),
    ("gemini", "gemini"),
)


def _provider_for_model(model: str) -> str:
    name = (model or "").lower()
    if "/" in name:
        name = name.split("/", 1)[1]
    for prefix, provider in _PROVIDER_PREFIXES:
        if name.startswith(prefix):
            return provider
    return "openai"


def install(app: Any, config: Any) -> None:
    proxy = getattr(app.state, "proxy", None)
    if proxy is None:
        raise RuntimeError("omp_stats: app.state.proxy is not set; upstream install order changed")

    from headroom.proxy.auth_mode import classify_client
    from headroom.proxy.outcome import RequestOutcome

    original = proxy.handle_compress

    async def _record(request: Any, response: Any, latency_ms: float) -> None:
        if getattr(response, "status_code", 0) != 200:
            return
        # Prewarm/warmup compressions (extension fires one per session to load the
        # embedding model) carry this header; they are throwaway and must not inflate
        # lifetime proxy stats.
        try:
            if request.headers.get("x-headroom-warmup") == "1":
                return
        except Exception:
            pass
        data = json.loads(bytes(response.body))
        tokens_before = int(data.get("tokens_before") or 0)
        if tokens_before <= 0:
            return
        tokens_after = int(data.get("tokens_after") or 0)
        tokens_saved = int(data.get("tokens_saved") or 0)
        body: dict[str, Any] = {}
        try:
            # Starlette caches the body on the request after the handler read it.
            body = json.loads((await request.body()).decode("utf-8"))
        except Exception:
            body = {}
        model = str(body.get("model") or "unknown")
        messages = body.get("messages")
        outcome = RequestOutcome(
            request_id=await proxy._next_request_id(),
            provider=_provider_for_model(model),
            model=model,
            original_tokens=tokens_before,
            optimized_tokens=tokens_after,
            output_tokens=0,
            tokens_saved=max(0, tokens_saved),
            attempted_input_tokens=tokens_before,
            total_latency_ms=latency_ms,
            transforms_applied=tuple(str(t) for t in (data.get("transforms_applied") or ())),
            num_messages=len(messages) if isinstance(messages, list) else 0,
            client=classify_client(request.headers) or "omp",
        )
        await proxy._record_request_outcome(outcome)

    async def handle_compress(request: Any) -> Any:
        start = time.time()
        response = await original(request)
        try:
            await _record(request, response, (time.time() - start) * 1000)
        except Exception:
            logger.exception("omp_stats: failed to record compress outcome")
        return response

    proxy.handle_compress = handle_compress
    logger.info("omp_stats: /v1/compress outcome recording enabled")
