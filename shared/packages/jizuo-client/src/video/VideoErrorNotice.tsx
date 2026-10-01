import { ErrorText } from "../ui/ErrorText.tsx";
import { ActionIcon } from "../ui/ActionIcon.tsx";
import { useId, type ReactNode } from "react";
import "./video-error.css";

export function VideoErrorNotice({ title = "操作未完成", message, children }: { title?: string; message: string; children?: ReactNode }) {
  const titleId = useId();
  return <div className="jz-video-error" role="alert" aria-labelledby={titleId}>
    <ActionIcon name="warning" className="jz-video-error-icon" />
    <div className="jz-video-error-content"><strong id={titleId}>{title}</strong><p>{<ErrorText error={message} operation="video" />}</p>{children}</div>
  </div>;
}
