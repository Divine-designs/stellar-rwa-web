import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

/** Flat-config replacement for the removed `next lint` / .eslintrc.json. */
export default [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts", "**/__tests__/**", "e2e/**"] },
  ...nextCoreWebVitals,
  {
    rules: {
      "react/jsx-no-target-blank": "error",
      // react-hooks v6's set-state-in-effect rule flags setState calls inside
      // a fetch-on-mount effect's async callback as "synchronous," even
      // though they run after an awaited RPC/fetch resolves. That's the
      // standard, correct data-fetching pattern (see hooks/useAsync.ts),
      // not the render-phase mutation the rule is meant to catch — downgraded
      // to warn rather than suppressed, so a genuine render-phase violation
      // still surfaces.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];
