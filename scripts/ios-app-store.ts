import { z } from "zod";
import type { AppStoreConnectClient } from "./apple-distribution";
import { readAppStoreReleaseNotes } from "./app-store-release-notes";

const resource = z.object({ id: z.string().min(1) });
const storeVersion = resource.extend({
  attributes: z.object({
    platform: z.literal("IOS"), versionString: z.string(), appVersionState: z.string(),
    copyright: z.string().nullish(), releaseType: z.string(),
  }),
});
const submission = resource.extend({
  attributes: z.object({ state: z.string(), submittedDate: z.string().nullable().optional() }),
});
const editableStates = new Set(["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED"]);
const publishedStates = new Set(["READY_FOR_DISTRIBUTION", "REPLACED_WITH_NEW_VERSION"]);
const localization = resource.extend({ attributes: z.object({
  locale: z.string(), description: z.string().nullish(), keywords: z.string().nullish(),
  supportUrl: z.string().nullish(), whatsNew: z.string().nullish(),
}) });

function requireEditableVersion(draft: z.infer<typeof storeVersion>, version: string) {
  if (draft.attributes.versionString !== version || !editableStates.has(draft.attributes.appVersionState)) {
    throw new Error(`iOS ${version} is not editable: ${draft.attributes.appVersionState}.`);
  }
}

async function primaryLocalization(client: AppStoreConnectClient, appId: string, draftId: string) {
  const app = z.object({ data: resource.extend({
    attributes: z.object({ primaryLocale: z.string().min(1) }),
  }) }).parse(await client.api(`/v1/apps/${appId}`)).data;
  const localizations = await client.list(`/v1/appStoreVersions/${draftId}/appStoreVersionLocalizations`, localization);
  const primary = localizations.filter(row => row.attributes.locale === app.attributes.primaryLocale);
  if (primary.length !== 1 || !primary[0]) throw new Error("Missing primary App Store localization.");
  return primary[0];
}

async function requireNoReview(client: AppStoreConnectClient, appId: string) {
  const reviews = await client.list("/v1/reviewSubmissions", submission, {
    "filter[app]": appId, "filter[platform]": "IOS",
    "filter[state]": "READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES,CANCELING,COMPLETING",
  });
  if (reviews.length) {
    throw new Error(`Resolve existing iOS review submission ${reviews[0]!.id} in App Store Connect before running publication again.`);
  }
}

export async function ensureAppStoreVersion(
  client: AppStoreConnectClient, appId: string, version: string, releaseNotes: string,
) {
  await requireNoReview(client, appId);
  const versions = await client.list(`/v1/apps/${appId}/appStoreVersions`, storeVersion, {
    "filter[platform]": "IOS",
  });
  const conflict = versions.find(row => row.attributes.versionString !== version
    && !publishedStates.has(row.attributes.appVersionState));
  if (conflict) {
    throw new Error(`Resolve pending iOS ${conflict.attributes.versionString} (${conflict.id}) before publishing ${version}. No version was changed.`);
  }
  const matching = versions.filter(row => row.attributes.versionString === version);
  if (matching.length > 1) throw new Error(`Apple returned multiple iOS ${version} versions.`);
  let draft = matching[0];
  let whatsNew: string | undefined;
  if (!draft) {
    const current = versions.filter(row => row.attributes.appVersionState === "READY_FOR_DISTRIBUTION");
    if (current.length !== 1 || !current[0]?.attributes.copyright?.trim()) {
      throw new Error("Prepare the first App Store version manually; automatic creation requires one current distributed iOS version with copyright.");
    }
    whatsNew = readAppStoreReleaseNotes(releaseNotes);
    console.error(`Creating iOS ${version} from the current listing; inspect App Store Connect before rerunning if creation is interrupted.`);
    draft = z.object({ data: storeVersion }).parse(await client.api("/v1/appStoreVersions", "POST", { data: {
      type: "appStoreVersions",
      attributes: { platform: "IOS", versionString: version,
        copyright: current[0].attributes.copyright, releaseType: "MANUAL" },
      relationships: { app: { data: { type: "apps", id: appId } } },
    } })).data;
    console.error(`Created iOS ${version} draft ${draft.id}; inherited metadata will be validated before upload.`);
  }
  requireEditableVersion(draft, version);
  const primary = await primaryLocalization(client, appId, draft.id);
  if (whatsNew !== undefined || (versions.some(row => publishedStates.has(row.attributes.appVersionState))
    && !primary.attributes.whatsNew?.trim())) {
    whatsNew ??= readAppStoreReleaseNotes(releaseNotes);
    const updated = z.object({ data: localization }).parse(await client.api(
      `/v1/appStoreVersionLocalizations/${primary.id}`, "PATCH", { data: {
        type: "appStoreVersionLocalizations", id: primary.id, attributes: { whatsNew },
      } },
    )).data;
    if (updated.id !== primary.id || updated.attributes.whatsNew !== whatsNew) {
      throw new Error("Apple did not confirm the intended App Store What's New.");
    }
  }
  const preparedId = await prepareAppStoreVersion(client, appId, version);
  if (preparedId !== draft.id) throw new Error("The prepared App Store version changed during preparation.");
  return preparedId;
}

export async function prepareAppStoreVersion(client: AppStoreConnectClient, appId: string, version: string) {
  const versions = await client.list(`/v1/apps/${appId}/appStoreVersions`, storeVersion, {
    "filter[platform]": "IOS", "filter[versionString]": version,
  });
  if (versions.length !== 1 || !versions[0]) {
    throw new Error(`Prepare exactly one iOS ${version} draft with its metadata and screenshots in App Store Connect first.`);
  }
  const draft = versions[0];
  requireEditableVersion(draft, version);
  if (!draft.attributes.copyright?.trim()) throw new Error(`iOS ${version} is missing copyright.`);
  await requireNoReview(client, appId);
  const primary = await primaryLocalization(client, appId, draft.id);
  const copy = primary.attributes;
  if (!copy.description?.trim() || !copy.keywords?.trim()
    || !z.url({ protocol: /^https?$/ }).safeParse(copy.supportUrl).success) {
    throw new Error("Complete the primary App Store description, keywords and support URL first.");
  }
  const published = await client.list(`/v1/apps/${appId}/appStoreVersions`, resource, {
    "filter[platform]": "IOS", "filter[appVersionState]": "READY_FOR_DISTRIBUTION,REPLACED_WITH_NEW_VERSION",
  });
  if (published.length && !copy.whatsNew?.trim()) {
    throw new Error("Complete the primary App Store release notes for this update first.");
  }
  const review = z.object({ data: resource.extend({ attributes: z.object({
    contactFirstName: z.string().min(1), contactLastName: z.string().min(1),
    contactEmail: z.email(), contactPhone: z.string().min(1), notes: z.string().min(1),
    demoAccountRequired: z.boolean(), demoAccountName: z.string().nullish(), demoAccountPassword: z.string().nullish(),
  }) }) }).parse(await client.api(`/v1/appStoreVersions/${draft.id}/appStoreReviewDetail`)).data.attributes;
  if (review.demoAccountRequired && (!review.demoAccountName?.trim() || !review.demoAccountPassword?.trim())) {
    throw new Error("Complete the required reviewer demo credentials in App Store Connect first.");
  }
  const sets = await client.list(`/v1/appStoreVersionLocalizations/${primary.id}/appScreenshotSets`,
    resource.extend({ attributes: z.object({ screenshotDisplayType: z.string() }) }));
  let iphone = false;
  let ipad = false;
  for (const set of sets) {
    const images = await client.list(`/v1/appScreenshotSets/${set.id}/appScreenshots`,
      resource.extend({ attributes: z.object({
        assetDeliveryState: z.object({ state: z.string() }).nullish(),
      }) }));
    if (images.some(image => image.attributes.assetDeliveryState?.state !== "COMPLETE")) {
      throw new Error(`Finish screenshot processing for ${set.attributes.screenshotDisplayType} first.`);
    }
    if (images.length) {
      iphone ||= set.attributes.screenshotDisplayType.startsWith("APP_IPHONE_");
      ipad ||= set.attributes.screenshotDisplayType.startsWith("APP_IPAD_");
    }
  }
  if (!iphone || !ipad) throw new Error("Upload completed primary-language screenshots for both iPhone and iPad first.");
  return draft.id;
}

export async function submitAppStoreVersion(
  client: AppStoreConnectClient, appId: string, version: string, draftId: string, buildId: string,
) {
  if (await prepareAppStoreVersion(client, appId, version) !== draftId) {
    throw new Error("The prepared App Store version changed during the build.");
  }
  await client.api(`/v1/appStoreVersions/${draftId}`, "PATCH", { data: {
    type: "appStoreVersions", id: draftId,
    attributes: { releaseType: "AFTER_APPROVAL", earliestReleaseDate: null },
    relationships: { build: { data: { type: "builds", id: buildId } } },
  } });
  const updated = z.object({ data: storeVersion }).parse(await client.api(`/v1/appStoreVersions/${draftId}`)).data;
  const linked = z.object({ data: resource }).parse(await client.api(`/v1/appStoreVersions/${draftId}/relationships/build`)).data;
  if (updated.attributes.releaseType !== "AFTER_APPROVAL" || linked.id !== buildId
    || updated.attributes.versionString !== version || !editableStates.has(updated.attributes.appVersionState)) {
    throw new Error("Apple did not confirm the intended build and automatic-after-approval release setting.");
  }
  await requireNoReview(client, appId);
  const created = z.object({ data: submission }).parse(await client.api("/v1/reviewSubmissions", "POST", { data: {
    type: "reviewSubmissions", attributes: { platform: "IOS" },
    relationships: { app: { data: { type: "apps", id: appId } } },
  } })).data;
  console.error(`Created review submission ${created.id}; inspect it before rerunning if any later step fails.`);
  if (created.attributes.state !== "READY_FOR_REVIEW") throw new Error("Unexpected new review submission state.");
  await client.api("/v1/reviewSubmissionItems", "POST", { data: {
    type: "reviewSubmissionItems", relationships: {
      reviewSubmission: { data: { type: "reviewSubmissions", id: created.id } },
      appStoreVersion: { data: { type: "appStoreVersions", id: draftId } },
    },
  } });
  const items = await client.list(`/v1/reviewSubmissions/${created.id}/items`, resource.extend({
    relationships: z.object({ appStoreVersion: z.object({ data: resource.nullable() }) }),
  }), { include: "appStoreVersion" });
  if (items.length !== 1 || items[0]?.relationships.appStoreVersion.data?.id !== draftId) {
    throw new Error("Review submission contains unexpected or unrelated items; no submission was sent.");
  }
  await client.api(`/v1/reviewSubmissions/${created.id}`, "PATCH", {
    data: { type: "reviewSubmissions", id: created.id, attributes: { submitted: true } },
  });
  const deadline = Date.now() + 2 * 60_000;
  while (Date.now() < deadline) {
    const current = z.object({ data: submission }).parse(await client.api(`/v1/reviewSubmissions/${created.id}`)).data;
    if (["WAITING_FOR_REVIEW", "IN_REVIEW", "COMPLETING", "COMPLETE"].includes(current.attributes.state)
      && current.attributes.submittedDate) {
      return { appStoreVersionId: draftId, reviewSubmissionId: current.id,
        reviewState: current.attributes.state, releaseType: "AFTER_APPROVAL" };
    }
    if (current.attributes.state !== "READY_FOR_REVIEW") {
      throw new Error(`Review submission ${current.id} needs attention: ${current.attributes.state}.`);
    }
    await Bun.sleep(5_000);
  }
  throw new Error(`Apple did not confirm review submission ${created.id}; inspect it before rerunning. Submission was not retried.`);
}
