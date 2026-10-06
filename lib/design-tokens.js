// Single source of truth for JS-side design tokens. Mirrors app/mission.css. See spec: mission-control-premium-redesign (Requirement 9, Property 29).

export const TAB_RAIL_SIXTH_SLOT = "voice";

export const MOTION = {
  duration: {
    fast: 0.12,
    base: 0.24,
    slow: 0.36,
    hero: 0.6,
  },
  easing: {
    standard: [0.2, 0.0, 0.0, 1.0],
    soft: [0.4, 0.0, 0.2, 1.4],
  },
};

export const ORB_FALLBACK_COLORS = {
  halo1: "rgba(255,255,255,0.24)",
  halo2: "rgba(210,228,255,0.16)",
  halo3: "rgba(255,255,255,0.00)",
  particle: "rgba(220,232,255,0.86)",
};
