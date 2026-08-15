/**
 * The handful of rules that inline styles cannot express: `@keyframes`, and
 * the scrollbar pseudo-elements. Everything else on Agent Detail is a
 * `style={{...}}` object over `--ny-*` tokens, matching the prototype.
 *
 * Class names are `bh-` prefixed and the animations are `bh` prefixed so this
 * can never collide with NotYet UI's own stylesheet.
 */
export function AgentPageStyles() {
  return (
    <style>{`
@keyframes bhPulse { 0%,100% { opacity: 1; transform: scale(1) } 50% { opacity: .35; transform: scale(.82) } }
@keyframes bhRing { 0% { box-shadow: 0 0 0 0 var(--bh-ring-color) } 70% { box-shadow: 0 0 0 5px transparent } 100% { box-shadow: 0 0 0 0 transparent } }
.bh-scroll { scrollbar-width: thin }
.bh-scroll::-webkit-scrollbar { width: 10px; height: 10px }
.bh-scroll::-webkit-scrollbar-thumb { background: var(--ny-border-strong); border-radius: 8px; border: 2px solid transparent; background-clip: content-box }
.bh-scroll::-webkit-scrollbar-track { background: transparent }
@media (prefers-reduced-motion: reduce) {
  .bh-dot, .bh-pulse { animation: none !important }
}
`}</style>
  );
}
