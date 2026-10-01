import { AccountPanel, type AccountRemote } from "../account/AccountPanel.tsx";

export function JizuoSettingsCard({ account }: { account: AccountRemote }) {
  return (
    <div data-plugin="jizuo" data-surface="settings-card">
      <AccountPanel remote={account} />
    </div>
  );
}
