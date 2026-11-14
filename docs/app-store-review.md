# iPhone and iPad App Review

This guide prepares review information for the Apple client. It does not submit
an app, publish a policy, or establish that Apple has approved an alternative
review-access arrangement. Build and signing mechanics remain in
[Apple apps](apple-apps.md#public-ios-app-store-prerequisites).

## Public references and support

| Field | Value |
| --- | --- |
| Privacy Policy URL | `https://pablozaiden.github.io/clanky/privacy/` |
| Support URL | `https://pablozaiden.github.io/clanky/privacy/#contact` |
| Privacy and support contact | `clanky@zaiden.dev` |
| Source and software license | [Clanky repository](https://github.com/pablozaiden/clanky) and its MIT license |

The policy's canonical source is
[`assets/privacy/index.html`](../assets/privacy/index.html). Site builds include
the page, and whole-site publications preserve it. Publication verification
checks its exact contents.

Keep the policy limited to necessary data/use, recipient, retention/deletion
and contact disclosures. Technical explanations, demo instructions and other
review material belong in this guide, not in the policy.

Before entering these URLs in App Store Connect, deploy the approved page and
confirm that it is readable without a login. Enable receiving and monitoring
`clanky@zaiden.dev` before submission. An address that cannot receive messages is
not functional support. Do not put an unmonitored address into a submitted
version and represent it as an available support channel.

The in-app Privacy Policy links are the only policy-specific UI additions.
There is no new consent or onboarding screen. The software license remains MIT;
use Apple's standard end-user license terms for store distribution unless a
separately approved requirement calls for custom terms.

## Suggested store description

> Connect your iPhone or iPad to your own Clanky controller and manage your coding
> agents remotely. Follow conversations, browse project files, review
> changes, and use voice and file attachments from the existing Clanky interface.
>
> Clanky is a client for independently operated, self-hosted controllers. It does
> not include a hosted controller or AI subscription. Coding agents and commands
> run on the connected hosts, not on your iPhone or iPad. A reachable controller
> and the agents and providers configured by its operator are required for
> connected features.
>
> A local demonstration with fictional data is available without a server.

Use actual iPhone and iPad captures of the shipping app for store screenshots.
Show the working interface, not just its connection screen. Clearly identify
fictional demonstration content and avoid showing private repositories,
credentials, real account information, or unsupported capabilities.

## Suggested App Review notes

> Clanky is a client for existing, independently operated, self-hosted Clanky
> controllers. The publisher does not provide a hosted controller, central
> Clanky account, or AI service.
>
> Users connect to a controller they choose and authorize the client through
> that controller. Controller accounts and any administrative user-management
> actions belong to that independently operated server.
>
> Agents, commands, repositories, and other execution resources remain on the
> connected hosts. They are not executed on the iPhone or iPad. Native integration
> includes microphone permission, file selection/export, and platform-specific
> navigation controls.
>
> The App Store build uses the frontend packaged in the signed app and does
> not download frontend updates. Frontend changes require an app update.
>
> For an isolated demonstration, choose "Connect to an API" and enter
> `https://demo-controller` in the existing server-address field. This is a
> reserved client-side identifier, not a reachable network server. No login,
> personal credentials, controller access, or AI-provider account is required.
>
> The demonstration uses fictional data and simulated interactions kept only in
> browser memory. Reloading or leaving resets it. It does not execute real
> agents, commands, Git operations, or external provider calls. Operations outside
> its documented simulation return an explanatory error rather than executing.
>
> We request review using this isolated built-in demonstration because providing
> access to independently operated controllers would expose execution resources
> and private infrastructure. Please confirm whether this arrangement is
> acceptable under Guideline 2.1 or identify any additional review evidence needed.

The [Guideline 2.1](https://developer.apple.com/app-store/review/guidelines/#app-completeness)
built-in-demo alternative requires prior approval where applicable and must
adequately demonstrate the app's functionality. Do not claim a simulated run
verifies real authentication, execution, or third-party integration. Do not hide
the alias, detect reviewer identities, or silently substitute simulation for an
ordinary failed controller connection. If Apple needs evidence the simulation
cannot provide, resolve that request before declaring review readiness; this
guide does not authorize exposing a real controller.

A private-network deployment does not establish an automatic exception to
review access, and reviewers cannot be assumed to install a controller.
Without an accessible controller they cannot verify the real remote
integration. A recording of an actual isolated LAN session can support the
request for demo approval, but is not a guaranteed substitute for review access.

## Local demonstration walkthrough

Enter `https://demo-controller` in the existing API server field. From the
dashboard, the following journeys use only fictional, in-memory content:

1. Open **Demo: explore the observatory**, send a text message, and read the
   explicitly simulated reply.
2. Open the **Demo Observatory** resource card, choose **New Chat**, enter a
   name, and choose **Create**. Send a message in the new conversation.
3. In the workspace's actions menu, choose **Code Explorer**. Expand `src` and
   open `greeting.ts` to read the fictional source.
4. Open **Demo: explore the observatory**, select **Diff**, and expand
   `src/greeting.ts` to inspect the sample change.
5. Open **Demo imaginary Mesh server** from the dashboard to inspect its
   fictional chat and worker directory.
6. Open **Demo: basic shell** from the activity list or workspace. Enter `ls`
   to see a fixed fictional listing. Empty input repeats the prompt; other
   commands, including `ls` with arguments, are invalid. This is a local
   simulation using the terminal interface, not a Bash interpreter.

The fictional source files and sample chat diff are read-only. Demo chats remain
interactive; their replies are simulated rather than agent execution. Terminal
creation and management are not offered as working demo actions.
Automations are not simulated; their demo scenario remains undefined.

Operations such as **Pull Latest Changes** report that the action is not
simulated; they do not perform an operation on a real repository. Real agents,
actual terminal execution, authentication, providers, and native permissions require
separate validation and are not demonstrated by simulated success.

Use **Settings > General > Connection > Exit demo** to leave. Reloading also
ends the demo. Both retire its changes and retain any previously saved real
connection and credentials. If there is no saved connection, the existing
connection screen returns. Enter the reserved address again to start fresh.

## Privacy answers and account scope

Review the actual shipping build against
[Apple's privacy definitions](https://developer.apple.com/app-store/app-privacy-details/).
The following inventory distinguishes who can access information; it is not an
instruction to select "Data Not Collected" without assessing the final build.

| Information | Normal processing |
| --- | --- |
| Sessions, connection details, preferences, drafts, and caches | Persistent client storage; sessions are used with the selected controller |
| Messages, attachments, instructions, repositories, and conversation output | Selected controller, authorized execution hosts, and configured providers |
| Voice audio | Device capture, selected controller, and configured voice provider |
| Native/session diagnostics | Limited local history, not automatically uploaded to the publisher |
| Collaboration and configured integration traffic | The destinations selected by the controller operator |
| Public hosting requests | Third-party infrastructure can receive IP addresses and ordinary request metadata |
| Support email | Information the sender voluntarily provides to the publisher |
| Demonstration content | Fictional, memory-only state; no controller or provider request |

Do not attribute all independently operated controller storage to the publisher.
Conversely, do not claim that self-hosting eliminates disclosures for any actual
publisher/partner collection. The native privacy manifest declares the shell's
current required-reason API use and no shell tracking or collected-data types;
it does not replace the assessment of the complete app's behavior.

The iOS client retains existing remote account administration. An administrator
can create users on the selected controller; there is no central publisher
account. Do not describe the app as strictly unable to create accounts.
[Apple's account-deletion guidance](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion/)
does not document a blanket self-hosting exception. Explain the actual scope
and resolve any review request rather than silently deleting features or
treating local sign-out as remote account deletion.

Answer age-rating and content-rights questions for the actual features and
providers supported by the shipping app. Do not copy another coding app's
rating, claim output is always suitable for children, or claim ownership of
third-party provider content. Preserve applicable software license notices.

## Distribution and readiness gates

The existing internal TestFlight workflow remains internal-only. Its previous
uploads cannot be converted into a public-review build. A separately authorized
App Store Connect export needs a new build number and must omit
`testFlightInternalTestingOnly=true`.
The separate manual [App Store workflow](apple-apps.md#public-ios-app-store-prerequisites)
uses the latest stable versioned release, reuses its prepared App Store draft or
creates one inheriting the current listing, verifies public eligibility, submits
the version to review and enables automatic publication after approval. The
normal release task asks for the new version's What's New; existing draft notes
are preserved. Inherited metadata and screenshots must pass preflight, and
changed behavior still needs updated store/reviewer information. The workflow
must not be run just to validate tooling.

Public App Store builds must use the bundled frontend and omit the frontend
Settings bundle, regardless of saved channels or downloaded snapshots from an
earlier installation. Ordinary internal TestFlight builds keep their existing
frontend updates and Settings toggle.

Before marking a version ready to submit:

- Publish and check the policy and support URLs, enable the contact mailbox,
  and approve the final disclosures and metadata.
- Exercise the documented demo journeys and verify that controller/provider
  traffic is not emitted. Confirm saved real connections are preserved.
- Validate the shipping iPhone/iPad app, microphone denial, file selection/export,
  layout/keyboard behavior, and foreground recovery on supported devices.
- Inspect the signed archive and exported app for `PrivacyInfo.xcprivacy`,
  the bundled-only frontend policy and absence of the frontend Settings bundle,
  declared permissions, signing, version, architecture, and
  accurate encryption/export declarations. Source files alone are not evidence
  that an exported app includes the correct resources.
- Confirm Apple's acceptance of the demo review-access arrangement and address
  any requests concerning privacy, accounts, content, or other shipping behavior.
- Export/upload an eligible build only with authorization, verify processing,
  and select it for review through an authorized account.

Code completion is not publication or approval. Keep unavailable device/signing
checks and external review decisions explicit rather than marking them passed.
