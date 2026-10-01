import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useId, useState } from "react";

import "./about.css";

export interface AboutJizuoRemote {
  checkForUpdates(): Promise<void>;
}

function updateErrorMessage(reason: unknown): string {
  return userErrorMessage(reason, "无法检查更新，请稍后重试", { operation: "checkForUpdates", effect: "read" });
}

export function AboutJizuo({
  version,
  remote,
}: {
  version: string;
  remote: AboutJizuoRemote;
}) {
  const headingId = useId();
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const checkForUpdates = async (): Promise<void> => {
    if (checking) return;
    setChecking(true);
    setMessage(undefined);
    setError(undefined);
    try {
      await remote.checkForUpdates();
      setMessage("检查已开始，结果会在即作中显示。");
    } catch (reason) {
      setError(updateErrorMessage(reason));
    } finally {
      setChecking(false);
    }
  };

  return (
    <section
      className="jz-about-panel"
      aria-labelledby={headingId}
      aria-busy={checking}
      data-plugin="jizuo"
      data-surface="about"
    >
      <header>
        <h2 id={headingId}>关于即作</h2>
        <p>查看当前版本并检查已签名更新。</p>
      </header>

      <div className="jz-about-version">
        <dl>
          <dt>当前版本</dt>
          <dd>{version}</dd>
        </dl>
        <IconButton icon="reset" label={(checking ? "正在检查" : "检查更新")}
          type="button"
          disabled={checking}
          onClick={() => { void checkForUpdates(); }}
         />
      </div>

      <p className="jz-about-note">
        更新包会在安装前验证签名。安装前请保存正在编辑的内容。
      </p>
      {error && <p className="jz-about-message is-error" role="alert">{error}</p>}
      {message && <p className="jz-about-message" role="status">{message}</p>}
    </section>
  );
}
