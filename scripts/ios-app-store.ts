import { z } from "zod";
import type { AppStoreConnectClient } from "./apple-distribution";

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

async function requireNoReview(client: AppStoreConnectClient, appId: string) {
  const reviews = await client.list("/v1/reviewSubmissions", submission, {
    "filter[app]": appId, "filter[platform]": "IOS",
    "filter[state]": "READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES,CANCELING,COMPLETING",
  });
  if (reviews.length) {
    throw new Error(`Resolve existing iOS review submission ${reviews[0]!.id} in App Store Connect before running publication again.`);
  }
}

export async function prepareAppStoreVersion(client: AppStoreConnectClient, appId: string, version: string) {
  const versions = await client.list(`/v1/apps/${appId}/appStoreVersions`, storeVersion, {
    "filter[platform]": "IOS", "filter[versionString]": version,
  });
  if (versions.length !== 1 || !versions[0]) {
    throw new Error(`Prepare exactly one iOS ${version} draft with its metadata and screenshots in App Store Connect first.`);
  }
  const draft = versions[0];
  if (draft.attributes.versionString !== version || !editableStates.has(draft.attributes.appVersionState)) {
    throw new Error(`iOS ${version} is not editable: ${draft.attributes.appVersionState}.`);
  }
  if (!draft.attributes.copyright?.trim()) throw new Error(`iOS ${version} is missing copyright.`);
  await requireNoReview(client, appId);
  const app = z.object({ data: resource.extend({
    attributes: z.object({ primaryLocale: z.string().min(1) }),
  }) }).parse(await client.api(`/v1/apps/${appId}`)).data;
  const localizations = await client.list(`/v1/appStoreVersions/${draft.id}/appStoreVersionLocalizations`,
    resource.extend({ attributes: z.object({
      locale: z.string(), description: z.string().nullish(), keywords: z.string().nullish(),
      supportUrl: z.string().nullish(), whatsNew: z.string().nullish(),
    }) }));
  const primary = localizations.filter(row => row.attributes.locale === app.attributes.primaryLocale);
  if (primary.length !== 1 || !primary[0]) throw new Error("Missing primary App Store localization.");
  const copy = primary[0].attributes;
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
  const sets = await client.list(`/v1/appStoreVersionLocalizations/${primary[0].id}/appScreenshotSets`,
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
