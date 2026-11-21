import { Menu, Wifi } from "lucide-react";
import { EXPERT_META } from "../data/moeDefaults";
import { ExpertFeatureId } from "../types/moe";

interface HeaderBarProps {
  activeFeature: ExpertFeatureId;
  onSelectFeature: (feature: ExpertFeatureId) => void;
  onOpenLanModal: () => void;
  onOpenMobileSidebar: () => void;
}

const FEATURES: ExpertFeatureId[] = [
  "chat",
  "text-to-image",
  "image-to-image",
  "image-to-video",
];

export function HeaderBar({
  activeFeature,
  onSelectFeature,
  onOpenLanModal,
  onOpenMobileSidebar,
}: HeaderBarProps) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-8 border-b border-slate-200 bg-white/95 px-4 backdrop-blur-sm dark:border-slate-800 dark:bg-slate-950/95 lg:px-6">
      {/* Zone 1: Brand wordmark (single text element) */}
      <div className="flex items-center gap-3 shrink-0">
        <button
          type="button"
          onClick={onOpenMobileSidebar}
          aria-label="Open expert router menu"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-900 lg:hidden"
        >
          <Menu className="h-4 w-4" />
        </button>
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            onSelectFeature("chat");
          }}
          className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 dark:text-slate-100"
        >
          M5 MoE Studio
        </a>
      </div>

      {/* Zone 2: 4 single-line workspace links */}
      <nav
        aria-label="MoE Features"
        className="hidden md:flex items-center gap-6 overflow-x-auto"
      >
        {FEATURES.map((id) => {
          const active = activeFeature === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelectFeature(id)}
              className={`relative py-4 text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600 ${
                active
                  ? "text-slate-950 dark:text-white"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              {EXPERT_META[id].shortLabel}
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 bottom-0 h-0.5 bg-blue-600 dark:bg-blue-500"
                />
              )}
            </button>
          );
        })}
      </nav>

      {/* Zone 3: 1 primary action */}
      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={onOpenLanModal}
          className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0 dark:bg-blue-600 dark:hover:bg-blue-500"
        >
          <Wifi className="h-3.5 w-3.5" />
          <span>LAN Access</span>
        </button>
      </div>
    </header>
  );
}
