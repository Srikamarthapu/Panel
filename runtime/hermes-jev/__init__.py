"""Out-of-tree plugin; all tool execution remains owned by Hermes."""

def register(ctx):
    from .runtime import select_next_tool, observe_tool, annotate_result, end_session
    from .context_engine import register_context
    from .model_router import choose_turn_model
    ctx.register_middleware("llm_execution", select_next_tool)
    register_context(ctx)
    ctx.register_hook("post_tool_call", observe_tool)
    ctx.register_hook("transform_tool_result", annotate_result)
    ctx.register_hook("on_session_end", end_session)
    # pre_model_route is an optional Hermes gateway extension installed only
    # when Discord model routing is requested. Keep the core plugin loadable on
    # hosts that do not expose this hook.
    from hermes_cli.plugins import VALID_HOOKS
    if "pre_model_route" in VALID_HOOKS:
        ctx.register_hook("pre_model_route", choose_turn_model)
