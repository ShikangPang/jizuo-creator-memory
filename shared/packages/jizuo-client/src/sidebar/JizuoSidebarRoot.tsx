import { userErrorMessage } from "@jizuo/contracts";
import { WorkSessions } from "./WorkSessions.tsx";
import { useSelection } from "../content/selection.ts";
import { CollapsedWorkNavigation } from "./CollapsedWorkNavigation.tsx";
import { ActionIcon } from "../ui/ActionIcon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useRef, useState } from "react";

import type { JizuoContentRemote } from "../content/remote.ts";
import { NewSessionDialog } from "./NewSessionDialog.tsx";
import { clearSidebarChromeWidth, setSidebarChromeWidth } from "../overlay/shellChrome.ts";
import { WorksSidebarPanel } from "./WorksSidebarPanel.tsx";
import { JizuoBrand } from "./JizuoBrand.tsx";
import type { JizuoSidebarSlotProps } from "./slots.ts";
import "./sidebar.css";

const COLLAPSE_SETTLE_MS = 150;
const SCROLLBAR_LINGER_MS = 2000;

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter((part): part is string => typeof part === "string" && part !== "").join(" ");
}

function PanelIcon() {
  return <ActionIcon name="sidebar" className="jz-sidebar-svg" />;
}

function NewChatIcon() {
  return <ActionIcon name="chat" className="jz-sidebar-svg" />;
}

export type JizuoSidebarRootProps = JizuoSidebarSlotProps & {
  remote: JizuoContentRemote;
};

export function JizuoSidebarRoot({
  collapsed,
  width,
  remote,
  startWorkSession,
  sessionNavigation,
  pickImportFile,
  pickExportFile,
  subscribeWorksChanges,
  toggleSidebar,
  renderSlot,
}: JizuoSidebarRootProps) {
  const selection = useSelection();
  const creating = useRef(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [showNewSession, setShowNewSession] = useState(false);
  const [createWorkRequest, setCreateWorkRequest] = useState(0);
  const [settled, setSettled] = useState(collapsed);
  const [pointerInside, setPointerInside] = useState(false);
  const column = useRef<HTMLElement>(null);
  const lingerTimer = useRef<number | undefined>(undefined);
  const lastWideWidth = useRef(width);
  const everWide = useRef(!collapsed);

  useEffect(() => {
    if (!collapsed) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => { setSettled(true); }, COLLAPSE_SETTLE_MS);
    return () => { window.clearTimeout(timer); };
  }, [collapsed]);

  const wide = !collapsed || !settled;
  if (!collapsed) {
    lastWideWidth.current = width;
    everWide.current = true;
  }

  useEffect(() => {
    setSidebarChromeWidth(!wide ? 56 : collapsed ? lastWideWidth.current : width);
    return clearSidebarChromeWidth;
  }, [wide, collapsed, width]);

  const cancelLinger = (): void => {
    window.clearTimeout(lingerTimer.current);
    lingerTimer.current = undefined;
  };
  const armLinger = (): void => {
    if (lingerTimer.current !== undefined) return;
    lingerTimer.current = window.setTimeout(() => {
      lingerTimer.current = undefined;
      setPointerInside(false);
    }, SCROLLBAR_LINGER_MS);
  };

  useEffect(() => {
    if (!pointerInside) return;
    const move = (event: PointerEvent): void => {
      const rect = column.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const inside = event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom;
      if (inside) cancelLinger();
      else armLinger();
    };
    document.addEventListener("pointermove", move);
    return () => {
      document.removeEventListener("pointermove", move);
      cancelLinger();
    };
  }, [pointerInside]);

  const beginSession = async (): Promise<void> => {
    if (sessionNavigation?.newGeneralSession === undefined) { setShowNewSession(true); return; }
    if (creating.current) return;
    creating.current = true;
    setSessionError(null);
    try { await sessionNavigation.newGeneralSession(); }
    catch (error) { setSessionError(userErrorMessage(error, "无法新建会话，请重试", { operation: "NewGeneralSession" })); }
    finally { creating.current = false; }
  };

  return (
    <aside
      ref={column}
      data-plugin="jizuo"
      data-surface="sidebar"
      className={cx(
        !wide && "collapsed",
        !wide && everWide.current && "rail-in",
        collapsed && wide && "fading",
        !pointerInside && "quiet-bars",
      )}
      style={wide ? { width: collapsed ? lastWideWidth.current : width } : undefined}
      onPointerEnter={() => { cancelLinger(); setPointerInside(true); }}
      onPointerLeave={armLinger}
    >
      <div className="jz-sidebar-logo-row">
        {wide && (
          <button type="button" className="jz-sidebar-brand-button wide" aria-label="新会话" onClick={() => { void beginSession(); }}>
            <JizuoBrand />
          </button>
        )}
        <button
          type="button"
          className="jz-sidebar-icon-button toggle"
          aria-label={collapsed ? "展开侧栏" : "折叠侧栏"}
          title={collapsed ? "展开侧栏" : "折叠侧栏"}
          onClick={toggleSidebar}
        >
          {!wide && <span className="jz-sidebar-rail-brand"><JizuoBrand compact /></span>}
          <span className="jz-sidebar-panel-icon"><PanelIcon /></span>
        </button>
      </div>

      {!wide && (
        <button type="button" className="jz-sidebar-new-session" aria-label="新会话" title="新会话" onClick={() => { void beginSession(); }}>
          <NewChatIcon />
        </button>
      )}

      {!wide && <nav aria-label="作品快捷入口">
        <IconButton icon="library" label="展开作品列表" onClick={toggleSidebar} />
        {selection.workId && <CollapsedWorkNavigation key={selection.workId} workId={selection.workId} remote={remote} />}
      </nav>}
      {wide && <IconButton icon="chat" label={"新建会话"} type="button" className="jz-sidebar-create-session" aria-label="新建会话" onClick={() => { void beginSession(); }} />}
      {wide && sessionNavigation?.newGeneralSession !== undefined && sessionNavigation.pickWorkspace !== undefined && <IconButton icon="library" label="更多会话选项" type="button" onClick={() => { setShowNewSession(true); }} />}
      {sessionError !== null && <p role="alert">{sessionError}</p>}
      {showNewSession && <NewSessionDialog
        {...sessionNavigation === undefined ? {} : { navigation: sessionNavigation }}
        close={() => { setShowNewSession(false); }}
        createWork={() => {
          setShowNewSession(false);
          if (collapsed) toggleSidebar();
          setCreateWorkRequest((value) => value + 1);
        }} />}
      <div className="jz-sidebar-region">
        <div className={cx("jz-sidebar-pane", !wide && "hidden")}>
            {sessionNavigation?.listGeneralSessions !== undefined && sessionNavigation.newGeneralSession !== undefined && <div className="jz-general-sessions"><WorkSessions navigation={sessionNavigation} /></div>}
            <WorksSidebarPanel
              remote={remote}
              openWorkSession={startWorkSession}
              createWorkRequest={createWorkRequest}
              {...sessionNavigation === undefined ? {} : { sessionNavigation }}
              pickImportFile={pickImportFile}
              {...(pickExportFile ? { pickExportFile } : {})}
              {...subscribeWorksChanges === undefined ? {} : { subscribeWorksChanges }}
            />
        </div>
      </div>

      <div className="jz-sidebar-footer">
        <div>{renderSlot("sidebar.footer.action", { wide })}</div>
        <div>{renderSlot("sidebar.settings", { wide })}</div>
      </div>
    </aside>
  );
}
