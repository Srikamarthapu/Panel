"use client";

import { useEffect, useRef } from "react";
import { MODE_DRAWS, resolvePreset } from "thinking-orbs/engine";
import { useVoice } from "@/components/voice/VoiceProvider.jsx";
import { resolveMissionOrb } from "@/lib/mission-orb-state.js";
import BloubAvatar from "@/components/avatar/bloub/BloubAvatar.jsx";
import { useInterfacePreferences } from "@/components/preferences/InterfacePreferencesProvider.jsx";
import { AVATAR_PALETTES } from "@/lib/interface-preferences.js";

/**
 * The upstream component is tuned to 20px and 64px canvases. At hero scale we
 * use its public drawing engine with the same 64px preset, painting at the
 * actual display resolution instead of enlarging a 64px bitmap.
 */
export function HeroThinkingOrb({ state, paused, speed, reducedMotion, color, nominalSize = 64 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const preset = resolvePreset(state, nominalSize);
    const drawMode = MODE_DRAWS[preset.mode];
    let diameter = 260;
    let dpr = 1;
    let frameId = null;
    let inView = false;
    let disposed = false;

    const paint = (now) => {
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, diameter, diameter);
      // A stable representative frame for unavailable/error/reduced-motion.
      const time = paused || reducedMotion ? 0.6 : now / 1000 * preset.speed * speed;
      drawMode(context, diameter, time, true, preset.opts);
      // Recolor the existing geometry without changing its opacity or motion.
      context.globalCompositeOperation = "source-in";
      context.fillStyle = color;
      context.fillRect(0, 0, diameter, diameter);
      context.globalCompositeOperation = "source-over";
    };

    const shouldAnimate = () => !disposed && !paused && !reducedMotion &&
      inView && document.visibilityState !== "hidden";

    const tick = (now) => {
      frameId = null;
      if (!shouldAnimate()) return;
      paint(now);
      frameId = requestAnimationFrame(tick);
    };

    const syncAnimation = () => {
      if (shouldAnimate()) {
        if (frameId === null) frameId = requestAnimationFrame(tick);
      } else if (frameId !== null) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }
    };

    const resize = () => {
      const box = canvas.getBoundingClientRect();
      diameter = Math.max(1, Math.min(box.width || 260, box.height || 260));
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(diameter * dpr);
      canvas.height = Math.round(diameter * dpr);
      // Paint one frame even if a native webview mounts while backgrounded.
      // The animation loop remains paused until the view is visible.
      paint(performance.now());
    };

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    const intersectionObserver = typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver(([entry]) => {
        inView = entry.isIntersecting;
        syncAnimation();
      })
      : null;
    if (intersectionObserver) intersectionObserver.observe(canvas);
    else inView = true;
    document.addEventListener("visibilitychange", syncAnimation);
    syncAnimation();

    return () => {
      disposed = true;
      if (frameId !== null) cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      intersectionObserver?.disconnect();
      document.removeEventListener("visibilitychange", syncAnimation);
    };
  }, [state, paused, speed, reducedMotion, color, nominalSize]);

  return <canvas ref={canvasRef} className="mcOrb__canvas" aria-hidden="true" />;
}

export default function MissionOrb({
  voiceState,
  activity,
  size = "hero",
  agentName = "Hermes",
  status,
  avatar = "orb",
  color,
  pointerFollowing,
  preserveBloubBody = false,
}) {
  const voice = useVoice();
  const { preferences, reducedMotion, palette } = useInterfacePreferences();
  const visual = resolveMissionOrb({
    voiceState,
    contextVoiceState: voice?.state,
    activity,
    status,
  });

  if (avatar === "bloub") {
    return (
      <div className="mcOrb mcOrb--bloub" data-size={size} data-state={visual.state} data-stale={visual.isStale || undefined}>
        <BloubAvatar state={visual.state} label={visual.label} agentName={agentName} reducedMotion={reducedMotion} pointerFollowing={pointerFollowing ?? preferences.pointerFollowing} color={color || preferences.avatarColor} preserveBody={preserveBloubBody} />
      </div>
    );
  }

  return (
    <div
      className="mcOrb"
      data-size={size}
      data-state={visual.state}
      data-orb-state={visual.orbState}
      data-stale={visual.isStale || undefined}
      role="img"
      aria-label={`${agentName || "Hermes"} orb, ${visual.label}`}
    >
      <div className="mcOrb__visual" aria-hidden="true">
        <HeroThinkingOrb state={visual.orbState} paused={visual.paused} speed={visual.speed} reducedMotion={reducedMotion} color={AVATAR_PALETTES[color]?.color || palette.color} nominalSize={size === "inline" ? 20 : 64} />
      </div>
    </div>
  );
}
