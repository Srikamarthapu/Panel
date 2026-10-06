"""Discord model choice contracts without live TypeSafe or model calls."""

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

PACKAGE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("jev_router_test", PACKAGE / "__init__.py", submodule_search_locations=[str(PACKAGE)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from jev_router_test import control_router, model_router


def choice(name, criteria, confidence=0.98):
    return {"type": "choice", "choice": name, "confidence": confidence,
            "probabilities": {key: 1.0 if key == name else 0.0 for key in criteria}}


class ModelRouteTests(unittest.TestCase):
    def setUp(self):
        self.config = {"enabled": True, "apiKey": "test", "modelRouting": True, "minConfidence": 0.85}
        self.models = ["deepseek-flash", "deepseek-v4-pro"]
        self.loader = patch.object(model_router, "load_config", return_value=self.config)
        self.loader.start()
        self.addCleanup(self.loader.stop)

    def route(self, **kwargs):
        return model_router.choose_turn_model(
            "Refactor the authentication flow across these modules", "deepseek-flash", "deepseek",
            self.models, platform="discord", session_id="test", **kwargs)

    def test_routes_complex_prompt_to_configured_model(self):
        def answer(state, questions, config):
            self.assertEqual(state["current_model"], "deepseek-flash")
            self.assertNotIn("apiKey", state)
            return {"answers": {"turn_model": choice("deepseek-v4-pro", questions["turn_model"]["criteria"])}}
        with patch.object(model_router, "request_decisions", side_effect=answer) as request, \
             patch.object(model_router, "emit") as emit:
            result = self.route()
            self.assertEqual((result["model"], result["provider"]), ("deepseek-v4-pro", "deepseek"))
            self.assertEqual(result["decision"]["mode"], "model")
        request.assert_called_once()
        self.assertEqual(emit.call_args.args[0]["model"], "deepseek-v4-pro")

    def test_uncertain_or_failed_jev_preserves_current_model(self):
        from jev_router_test.client import DecisionUnavailable
        for answer in [
            lambda state, questions, config: {"answers": {"turn_model": choice("deepseek-v4-pro", questions["turn_model"]["criteria"], 0.6)}},
            lambda state, questions, config: {"answers": {"turn_model": choice("unconfigured-model", questions["turn_model"]["criteria"])}},
            lambda state, questions, config: (_ for _ in ()).throw(DecisionUnavailable("timeout")),
        ]:
            with patch.object(model_router, "request_decisions", side_effect=answer), patch.object(model_router, "emit") as emit:
                self.assertIsNone(self.route())
                emit.assert_not_called()

    def test_scope_and_candidate_guards_prevent_unintended_routing(self):
        with patch.object(model_router, "request_decisions") as request:
            self.assertIsNone(model_router.choose_turn_model("hi", "deepseek-flash", "deepseek", self.models, platform="desktop"))
            self.assertIsNone(model_router.choose_turn_model("hi", "deepseek-flash", "deepseek", ["deepseek-flash", "bad model"], platform="discord"))
            self.config["modelRouting"] = False
            self.assertIsNone(self.route())
            request.assert_not_called()

    def test_control_inherits_omitted_route_but_rejects_explicit_overrides(self):
        config = {"model": {"provider": "deepseek", "default": "deepseek-flash", "base_url": "https://api.deepseek.com/v1/"},
                  "fallback_providers": [{"provider": "deepseek", "model": "deepseek-v4-pro"},
                                         {"provider": "deepseek", "model": "different-endpoint", "base_url": "https://other.example/v1"},
                                         {"provider": "deepseek", "model": "different-key", "api_key": "test-override"}]}
        self.assertEqual(control_router.configured_candidates(config)[2], self.models)
        with patch("hermes_cli.model_switch.model_derived_api_mode", side_effect=lambda provider, model, key: "responses" if model.endswith("pro") else "chat"):
            self.assertEqual(control_router.configured_candidates(config)[2], ["deepseek-flash"])

    def test_control_routes_before_cli_without_changing_explicit_voice_selection(self):
        def answer(state, questions, config):
            self.assertIn("Control Center", state["purpose"])
            return {"answers": {"turn_model": choice("deepseek-v4-pro", questions["turn_model"]["criteria"])} }

        with patch.object(model_router, "request_decisions", side_effect=answer), patch.object(model_router, "emit"):
            result = control_router.choose_control_model(
                "Refactor these files", {"model": {"provider": "deepseek", "default": "deepseek-flash"},
                "fallback_providers": [{"provider": "deepseek", "model": "deepseek-v4-pro"}]})
        self.assertEqual((result["model"], result["provider"]), ("deepseek-v4-pro", "deepseek"))

        with patch.object(model_router, "request_decisions") as request:
            self.assertIsNone(control_router.choose_control_model(
                "Refactor these files", {"model": {"provider": "deepseek", "default": "deepseek-flash"},
                "fallback_model": {"provider": "deepseek", "model": "deepseek-v4-pro"}},
                explicit_provider="deepseek", explicit_model="deepseek-flash"))
            request.assert_not_called()

    def test_control_candidates_are_bounded_same_provider_and_same_route(self):
        provider, primary, candidates = control_router.configured_candidates({
            "model": {"provider": "deepseek", "default": "flash", "base_url": "https://one.invalid/v1"},
            "fallback_providers": [
                {"provider": "other", "model": "foreign"},
                {"provider": "deepseek", "model": "wrong-endpoint", "base_url": "https://two.invalid/v1"},
                {"provider": "deepseek", "model": "pro"},
                {"provider": "deepseek", "model": "reasoner"},
                {"provider": "deepseek", "model": "extra"},
            ],
            "fallback_model": {"provider": "deepseek", "model": "legacy"},
        })
        self.assertEqual(provider, "deepseek")
        self.assertEqual(primary, "flash")
        self.assertEqual(candidates, ["flash", "pro", "reasoner", "extra"])

        _, _, candidates = control_router.configured_candidates({
            "model": {"provider": "deepseek", "default": "flash"},
            "fallback_providers": [
                {"provider": "deepseek", "model": "pro"},
                {"provider": "deepseek", "model": "reasoner"},
                {"provider": "deepseek", "model": "extra"},
                {"provider": "deepseek", "model": "fourth"},
            ],
        })
        self.assertEqual(candidates, ["flash", "pro", "reasoner", "extra"])

    def test_plugin_registration_does_not_require_optional_gateway_hook(self):
        from hermes_cli import plugins

        class Context:
            def __init__(self, supported):
                self.supported = supported
                self.hooks = []
                self.middleware = []

            def register_hook(self, name, callback):
                if name not in self.supported:
                    raise AssertionError("plugin registered a hook unsupported by this Hermes host")
                self.hooks.append(name)

            def register_middleware(self, name, callback):
                self.middleware.append(name)

        standard_hooks = {"post_tool_call", "transform_tool_result", "on_session_end"}
        with patch.object(plugins, "VALID_HOOKS", standard_hooks):
            standard = Context(standard_hooks)
            module.register(standard)
        self.assertNotIn("pre_model_route", standard.hooks)
        self.assertEqual(set(standard.middleware), {"llm_execution", "llm_request"})

        extended_hooks = standard_hooks | {"pre_model_route"}
        with patch.object(plugins, "VALID_HOOKS", extended_hooks):
            extended = Context(extended_hooks)
            module.register(extended)
        self.assertEqual(extended.hooks.count("pre_model_route"), 1)


if __name__ == "__main__":
    unittest.main()
