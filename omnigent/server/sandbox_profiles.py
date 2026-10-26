"""Provider discovery and immutable sandbox profile references."""

from __future__ import annotations

import json
from typing import Any

from fastapi import HTTPException
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import Engine

from omnigent.db.db_models import uuid_to_bytes
from omnigent.onboarding.sandboxes.profiles import ProviderSandboxProfile
from omnigent.server.managed_hosts import ManagedSandboxDeployment, build_owner_launcher
from omnigent.server.provider_sandbox_profiles import (
    ProviderProfileSnapshot,
    profile_context,
    provider_call,
    select_provider_profile,
)
from omnigent.stores.sandbox_profile_store import (
    SandboxProfileStore,
    encode_snapshot,
)


def _invalid_reference(error: ValueError) -> HTTPException:
    if isinstance(error, ValidationError):
        detail = "; ".join(
            f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}"
            for item in error.errors(include_input=False)
        )
    else:
        detail = str(error)
    return HTTPException(status_code=422, detail=detail)


class SandboxProfileCatalog:
    """Resolve current permission to use a provider-owned profile at its saved revision."""

    def __init__(self, engine: Engine, deployment: ManagedSandboxDeployment | None) -> None:
        self._store = SandboxProfileStore(engine)
        self._deployment = deployment

    def list_profiles(
        self,
        *,
        cursor: str | None = None,
        limit: int = 100,
        provider: str | None = None,
        user_id: str | None = None,
    ) -> tuple[list[dict[str, Any]], str | None]:
        managed = self.managed_providers(provider)
        if not 1 <= limit <= 100:
            raise HTTPException(
                status_code=422, detail="Profile page size must be between 1 and 100"
            )
        after: tuple[str, str] | None = None
        if cursor is not None:
            try:
                parts = json.loads(cursor)
                if (
                    not isinstance(parts, list)
                    or len(parts) != 2
                    or not all(isinstance(p, str) for p in parts)
                ):
                    raise ValueError("Invalid cursor")
                after = (parts[0], parts[1])
            except (ValueError, TypeError):
                raise HTTPException(
                    status_code=422, detail="Invalid sandbox profile cursor"
                ) from None
        rows = []
        for provider in managed:
            rows.extend(self._provider_profiles(provider, user_id))
        rows.sort(key=lambda row: (row["provider"], row["id"]))
        rows = [row for row in rows if after is None or (row["provider"], row["id"]) > after]
        page = rows[:limit]
        next_cursor = (
            json.dumps([page[-1]["provider"], page[-1]["id"]]) if len(rows) > limit else None
        )
        return page, next_cursor

    def managed_providers(self, provider: str | None = None) -> list[str]:
        if self._deployment is None:
            return []
        managed = []
        for entry in self._deployment.configs:
            if provider is not None and entry.provider != provider:
                continue
            if not entry.managed_launch_supported:
                continue
            if not provider_call(entry.launcher_factory).manages_profiles:
                continue
            if not entry.provider or not entry.provider.strip():
                raise HTTPException(
                    status_code=422,
                    detail="Provider-managed sandbox profiles require a configured provider name",
                )
            managed.append(entry.provider)
        return managed

    def _provider_profiles(self, provider: str, user_id: str | None) -> list[dict[str, Any]]:
        context = profile_context(user_id)
        assert self._deployment is not None
        entry = self._deployment.for_provider(provider)
        assert entry is not None

        def read() -> list[ProviderSandboxProfile]:
            profiles = TypeAdapter(list[ProviderSandboxProfile]).validate_python(
                build_owner_launcher(entry, self._deployment, context.user_id).list_profiles(
                    context
                )
            )
            if len(profiles) > 1000 or len({p.id for p in profiles}) != len(profiles):
                raise ValueError("Provider catalog must have at most 1000 unique profiles")
            return profiles

        return [
            {
                **profile.model_dump(),
                "provider": provider,
            }
            for profile in provider_call(read)
        ]

    def require_selection(self, provider: str | None, *, user_id: str | None = None) -> None:
        if self._deployment is None:
            return
        provider = provider or self._deployment.default.provider
        if provider in self.managed_providers(provider):
            profile_context(user_id)
            raise HTTPException(
                status_code=422, detail="Choose a sandbox profile for this provider"
            )

    def resolve(
        self,
        profile_id: str,
        expected_revision: str | None = None,
        provider: str | None = None,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        selected_provider = provider or (
            self._deployment.default.provider if self._deployment else None
        )
        if selected_provider in self.managed_providers(selected_provider):
            assert selected_provider is not None
            context = profile_context(user_id)
            profiles = self._provider_profiles(selected_provider, user_id)
            selected = next((p for p in profiles if p["id"] == profile_id), None)
            if selected is None:
                raise HTTPException(status_code=403, detail="Sandbox profile access denied")
            if expected_revision is not None and selected["revision"] != expected_revision:
                raise HTTPException(
                    status_code=409, detail="Sandbox profile changed. Choose a profile again."
                )
            snapshot = ProviderProfileSnapshot.model_validate(
                {
                    **selected,
                    "user_id": context.user_id,
                    "workspace_id": context.workspace_id,
                }
            ).model_dump()
            return self.validate_snapshot(snapshot)
        raise HTTPException(
            status_code=422, detail="Sandbox profiles are unavailable for this provider"
        )

    def validate_snapshot(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        """Recheck authorization for a session's accepted provider reference."""
        try:
            saved_reference = ProviderProfileSnapshot.model_validate(snapshot).model_dump()
            encode_snapshot(saved_reference)
        except ValueError as exc:
            raise _invalid_reference(exc) from exc
        entry = (
            self._deployment.for_provider(saved_reference["provider"])
            if self._deployment
            else None
        )
        if entry is None or not entry.managed_launch_supported:
            raise HTTPException(status_code=409, detail="Sandbox profile provider unavailable")
        launcher = provider_call(
            lambda: build_owner_launcher(entry, self._deployment, saved_reference["user_id"])
        )
        select_provider_profile(launcher, saved_reference)
        return saved_reference

    def inherit_snapshot(self, snapshot: dict[str, Any], user_id: str | None) -> dict[str, Any]:
        context = profile_context(user_id)
        return self.validate_snapshot({**snapshot, "user_id": context.user_id})

    def bind_session(self, session_id: str, snapshot: dict[str, Any]) -> None:
        try:
            self._store.bind_session(session_id, self.validate_snapshot(snapshot))
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    def get_session_snapshot(self, session_id: str) -> dict[str, Any] | None:
        return self._store.get_session_snapshot(session_id)

    def bind_host(self, session_id: str, host_id: str) -> None:
        try:
            self._store.bind_host(session_id, host_id)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    def get_host_snapshot(self, host_id: str) -> dict[str, Any] | None:
        return self._store.get_host_snapshot(host_id)

    def require_session_host(
        self,
        session_id: str,
        host_id: str,
        *,
        bind: bool = True,
        sandbox_provider: str | None = None,
        user_id: str | None = None,
    ) -> None:
        """After host ownership checks, inherit or match the host's accepted profile."""
        host_snapshot = self.get_host_snapshot(host_id)
        session_snapshot = self.get_session_snapshot(session_id)
        if host_snapshot is not None:
            self.validate_snapshot(host_snapshot)
            if user_id is not None and host_snapshot["user_id"] != user_id:
                raise HTTPException(
                    status_code=403, detail="Sandbox profile execution identity mismatch"
                )
        elif sandbox_provider is not None:
            self.require_selection(sandbox_provider, user_id=user_id)
        saved_host_id = self._store.get_session_host_id(session_id)
        if saved_host_id is not None and saved_host_id != uuid_to_bytes(host_id).hex():
            raise HTTPException(
                status_code=409, detail="A profiled session cannot be moved to a different host"
            )
        if session_snapshot is not None and (
            host_snapshot is None
            or any(
                session_snapshot[key] != host_snapshot[key]
                for key in ("id", "revision", "provider", "user_id", "workspace_id")
            )
        ):
            raise HTTPException(
                status_code=409, detail="Session and host sandbox profiles do not match"
            )
        if not bind:
            return
        if session_snapshot is None and host_snapshot is not None:
            self.bind_session(session_id, host_snapshot)
        self.bind_host(session_id, host_id)
