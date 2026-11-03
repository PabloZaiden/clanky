import { useState } from "react";
import type { WebAppConfigResponse } from "../contracts";
import { FormSection, Panel } from "@pablozaiden/webapp/web";
import { AccountSection } from "./settings/account-section";
import { SecuritySection } from "./settings/security-section";
import { SessionsSection } from "./settings/sessions-section";

export function ServerAccountScreen({ config, refresh }: {
  config: WebAppConfigResponse;
  refresh: () => Promise<void>;
}) {
  const [error, setError] = useState<string>();
  return (
    <main className="wapp-auth-screen">
      <Panel title={`${config.appName} account`}>
        {error ? <p className="wapp-error" role="alert">{error}</p> : null}
        <AccountSection config={config} refresh={refresh} setError={setError} category="account" />
        <FormSection title="Security">
          <SecuritySection config={config} refresh={refresh} setError={setError} />
          <SessionsSection config={config} setError={setError} />
        </FormSection>
      </Panel>
    </main>
  );
}
