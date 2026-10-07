"""Instance-scoped SOUL identity override for Control's saved Panel profiles.

The Hermes runtime reads its primary SOUL from the ambient HERMES_HOME. Control
profiles keep their own SOUL in Panel data, so this adapter dispatches the native
identity slot per AIAgent instance without changing installed Hermes files,
environment-wide HERMES_HOME, credentials, skills, or memory paths.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any


logger = logging.getLogger(__name__)
_PATCH_MARKER = "_panel_profile_identity_dispatch"
_PROFILE_SOUL_MAX_CHARS = 20_000


def install_panel_identity_override() -> bool:
    """Install an idempotent per-agent wrapper around Hermes' primary SOUL slot."""
    try:
        import agent.system_prompt as system_prompt

        current = getattr(system_prompt, "_identity_parts", None)
        if not callable(current):
            return False
        if getattr(current, _PATCH_MARKER, False):
            return True

        native_identity_parts = current

        def panel_identity_parts(agent: Any, ctx_len: int | None):
            soul = getattr(agent, "_panel_profile_soul", None)
            if not isinstance(soul, str) or not soul.strip():
                return native_identity_parts(agent, ctx_len)
            from agent.prompt_builder import _scan_context_content, _truncate_content

            # Panel's saved SOUL.md is user-authored profile content. Apply the
            # native scanner and context limit while keeping the native primary
            # identity slot and all other system-prompt sections intact.
            content = _scan_context_content(soul.strip(), "SOUL.md", user_authored=True)
            path = getattr(agent, "_panel_profile_soul_path", "")
            content = _truncate_content(
                content,
                "SOUL.md",
                context_length=ctx_len,
                read_path=path if isinstance(path, str) and path else "SOUL.md",
            )
            if not content.strip():
                raise RuntimeError("The saved Panel agent identity is empty.")
            return ([content], True)

        setattr(panel_identity_parts, _PATCH_MARKER, True)
        setattr(panel_identity_parts, "_panel_native_identity_parts", native_identity_parts)
        system_prompt._identity_parts = panel_identity_parts
        return True
    except Exception:
        logger.debug("Could not install Control profile identity override", exc_info=True)
        return False


def apply_panel_profile_identity(
    agent: Any,
    soul: Any,
    *,
    soul_path: str = "",
) -> bool:
    """Bind one saved SOUL to an AIAgent and invalidate only its cached prompt once.

    The native session row stores a built system prompt as a cache. Clearing that
    single field when the selected profile identity changes lets Hermes rebuild it
    through the normal prompt path, including tool-aware sections and cache tiers.
    """
    if not isinstance(soul, str) or not soul.strip() or len(soul) > _PROFILE_SOUL_MAX_CHARS:
        return False
    if not install_panel_identity_override():
        return False

    normalized = soul.strip()
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    if getattr(agent, "_panel_profile_soul_digest", None) == digest:
        return True

    agent._panel_profile_soul = normalized
    agent._panel_profile_soul_path = soul_path if isinstance(soul_path, str) else ""
    agent._panel_profile_soul_digest = digest
    # Saved agents always have a primary identity, including sessions whose
    # general workspace context files are disabled by the native runtime.
    agent.load_soul_identity = True
    agent._cached_system_prompt = None
    agent._cached_system_prompt_static = None
    agent._static_rebuild_failed_for = None
    if hasattr(agent, "_plugin_system_prompt_sections_snapshot"):
        agent._plugin_system_prompt_sections_previous = agent._plugin_system_prompt_sections_snapshot
        del agent._plugin_system_prompt_sections_snapshot

    db = getattr(agent, "_session_db", None)
    clear_prompt = getattr(db, "update_system_prompt", None)
    session_id = getattr(agent, "session_id", None)
    if callable(clear_prompt) and isinstance(session_id, str) and session_id:
        try:
            clear_prompt(session_id, None)
        except Exception:
            # A restored native session can otherwise reload the old ambient
            # identity from its persisted cache, so fail closed and retry on the
            # next prompt instead of claiming the profile was applied.
            logger.warning("Could not clear cached prompt for a changed Panel agent identity", exc_info=True)
            agent._panel_profile_soul_digest = None
            return False
    return True
