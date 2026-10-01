import { useEffect, useRef, type ComponentProps } from "react";
import { WorksSidebarPanel } from "./WorksSidebarPanel.tsx";
import { ActionIcon } from "../ui/ActionIcon.tsx";
import { setSelection } from "../content/selection.ts";
import { clearSidebarChromeWidth, setSidebarChromeWidth } from "../overlay/shellChrome.ts";
import "./sidebar.css";
import "./native-creation.css";

export function NativeCreationIcon() { return <ActionIcon name="book" />; }

/** Occupies an official Harness main panel; the host owns its sidebar and sessions. */
export function NativeCreationProjects(props: ComponentProps<typeof WorksSidebarPanel>) {
  const projects = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const column = projects.current;
    if (!column) return;
    const measure = () => setSidebarChromeWidth(column.getBoundingClientRect().right);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(column);
    if (column.parentElement) observer?.observe(column.parentElement);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      setSelection({ overlay: null });
      clearSidebarChromeWidth();
    };
  }, []);
  return <section data-plugin="jizuo" data-surface="native-creation" aria-label="即作创作">
    <div ref={projects} className="jz-native-projects"><WorksSidebarPanel {...props} /></div>
    <div className="jz-native-project-hint"><h1>即作创作</h1><p>选择项目，打开已启用的写作、视频或记忆功能。</p></div>
  </section>;
}
