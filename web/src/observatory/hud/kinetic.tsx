// Kinetic text: word-by-word reveals and slot-machine number reels (the film's vocabulary, time-driven here).
import { useEffect, useRef, useState } from "react";

/** Each word rises out of a blur with a slight tilt. Re-plays when `text` changes. */
export function Words({ text, className, delay = 0, step = 45, as: Tag = "span" }: { text: string; className?: string; delay?: number; step?: number; as?: "span" | "h1" | "h2" | "p" }) {
  const words = text.split(/(\s+)/);
  let k = 0;
  return (
    <Tag className={`words ${className ?? ""}`} key={text}>
      {/* screen readers get the plain sentence; the animated words are hidden from them */}
      <span className="sr-only">{text}</span>
      {words.map((w, i) =>
        /^\s+$/.test(w) ? (
          w
        ) : (
          <span key={i} aria-hidden="true" className={`w ${/\d/.test(w) ? "w-num" : ""}`} style={{ animationDelay: `${delay + step * k++}ms` }}>
            {w}
          </span>
        ),
      )}
    </Tag>
  );
}

const DIGITS = "0123456789";

/** Slot-machine reel: digits spin and land left to right. Non-digits are static. */
export function Reel({ value, className, delay = 0 }: { value: string; className?: string; delay?: number }) {
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    setShown(false);
    const id = window.setTimeout(() => setShown(true), 30 + delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  let d = 0;
  return (
    <span ref={ref} className={`reel2 ${className ?? ""} ${shown ? "on" : ""}`} key={value}>
      {/* screen readers and copy/paste get the value once, not the spinning digit strips */}
      <span className="sr-only">{value}</span>
      {[...value].map((ch, i) => {
        const idx = DIGITS.indexOf(ch);
        if (idx < 0)
          return (
            <span key={i} className="reel2-ch" aria-hidden="true">
              {ch}
            </span>
          );
        const n = d++;
        return (
          <span key={i} className="reel2-col" aria-hidden="true">
            <span className="reel2-strip" style={{ transform: shown ? `translateY(-${(10 + idx) * 5}%)` : "translateY(0)", transitionDelay: `${delay + n * 70}ms` }}>
              {[...DIGITS, ...DIGITS].map((x, j) => (
                <span key={j}>{x}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/** Animated counter (ease-out) for numbers that update often. */
export function Count({ value, format }: { value: number; format: (v: number) => string }) {
  const [v, setV] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const a = from.current, b = value;
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const k = Math.min(1, (performance.now() - t0) / 500);
      const e = 1 - Math.pow(1 - k, 3);
      setV(a + (b - a) * e);
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = b;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{format(v)}</>;
}
