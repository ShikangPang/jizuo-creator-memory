import { useLayoutEffect, useRef } from "react";
import { JizuoBrandMark } from "../../jizuo-client/src/brand/JizuoBrandMark.tsx";

import "./hero-brand.css";

const INTRO_QUERY = "jizuo_intro";

export function JizuoHeroBrand({ size, className }: { size: number; className?: string }) {
  const brand = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const target = brand.current;
    const headline = target?.closest<HTMLElement>('[class*="_headline"]');
    if (!target || !headline) return;

    headline.classList.add("jz-hero-headline");
    const url = new URL(window.location.href);
    let frame = 0;
    let preview: HTMLElement | undefined;
    let animation: Animation | undefined;
    const finish = () => {
      target.style.opacity = "";
      preview?.remove();
      preview = undefined;
    };
    const updateVisibility = () => {
      const fits = target.getBoundingClientRect().width <= headline.getBoundingClientRect().width;
      target.style.visibility = fits ? "" : "hidden";
      if (!fits) {
        animation?.cancel();
        finish();
      }
    };
    // Keep measuring the single-line copy while hidden so widening restores it.
    updateVisibility();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateVisibility);
    observer?.observe(headline);
    observer?.observe(target);

    if (url.searchParams.get(INTRO_QUERY) === "1") {
      // The destination remains invisible until the moving copy reaches it.
      target.style.opacity = "0";
      frame = window.requestAnimationFrame(() => {
        const rect = target.getBoundingClientRect();
        const front = document.elementFromPoint?.(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        const covered = front && !headline.contains(front) && !front.contains(headline);
        const outsideViewport =
          rect.right <= 0 ||
          rect.bottom <= 0 ||
          rect.left >= window.innerWidth ||
          rect.top >= window.innerHeight;
        url.searchParams.delete(INTRO_QUERY);
        window.history.replaceState(window.history.state, "", url);
        if (
          target.style.visibility === "hidden" ||
          rect.width === 0 ||
          rect.height === 0 ||
          outsideViewport ||
          covered ||
          window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ) {
          finish();
          return;
        }

        preview = target.cloneNode(true) as HTMLElement;
        preview.classList.add("jz-hero-brand--intro");
        preview.setAttribute("aria-hidden", "true");
        // Freeze the destination's responsive typography when moving the copy to body.
        const font = window.getComputedStyle(target);
        Object.assign(preview.style, {
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          color: font.color,
          fontFamily: font.fontFamily,
          fontSize: font.fontSize,
          fontWeight: font.fontWeight,
          lineHeight: font.lineHeight,
          opacity: "1",
        });
        document.body.append(preview);

        const dx = window.innerWidth / 2 - (rect.left + rect.width / 2);
        const dy = window.innerHeight / 2 - (rect.top + rect.height / 2);
        animation = preview.animate?.(
          [
            { transform: `translate(${dx}px, ${dy}px) scale(1.35)`, opacity: 1 },
            { transform: "translate(0, 0) scale(1)", opacity: 1 },
          ],
          { duration: 760, easing: "cubic-bezier(.22, 1, .36, 1)" },
        );
        if (animation) {
          animation.onfinish = finish;
          animation.oncancel = finish;
        } else {
          finish();
        }
      });
    }

    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
      animation?.cancel();
      finish();
      target.style.visibility = "";
      headline.classList.remove("jz-hero-headline");
    };
  }, []);

  return (
    <span className="jz-hero-brand" ref={brand}>
      <JizuoBrandMark size={size} {...(className ? { className } : {})} />
      <span className="jz-hero-brand__motto">把一个想法，写成完整作品</span>
    </span>
  );
}
