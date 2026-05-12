import AtpAgent, { RichText } from "@atproto/api";
import { Label } from "./labelStream";
import { UserDatabase } from "./userDatabase";
import { formatDuration, getAccountAgeAndHandle } from "./utils";
import { logger } from "./logger";

const SPAM_GRACE_PERIOD_DAYS = 14;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SPAM_GRACE_PERIOD_MS = SPAM_GRACE_PERIOD_DAYS * ONE_DAY_MS;

export interface TakedownOptions {
    did: string; // Note: This might contain an AT URI (at://...)
    src: string;
    label: Label;
}

export const LABEL_TYPES: Record<string, string> = {
    "!takedown": "banned",
    "!suspend": "suspended",
    "!hide": "hidden",
    "!warn": "marked with a warning",
    rude: "marked as rude",
};

export class PostMaker {
    private userDatabase = UserDatabase.getInstance();
    private agent: AtpAgent;
    constructor(agent: AtpAgent) {
        this.agent = agent;
    }

    public async handleTakedown(options: TakedownOptions): Promise<void> {
        // check if record we wanna look at (in label_types)
        if (!(options.label.val in LABEL_TYPES)) {
            //logger.debug(`Skipping takedown for label: ${options.label.val} on ${options.did} from ${options.src}`);
            return;
        }

        if (options.did.startsWith("at://")) {
            // maybe re-add later?
            // const { handle: srcHandle } = await getAccountAgeAndHandle(options.src);

            // let recordType = "Record";
            // let hashtag = "#bskyModeration";

            // if (options.did.includes("/app.bsky.feed.post/")) {
            //     recordType = "Post";
            //     hashtag = "#bskyModeration #postremoved";
            // }

            // if (options.did.includes("/app.bsky.graph.list/")) {
            //     recordType = "List";
            //     hashtag = "#bskyModeration #listremoved";
            // }

            // const postContent = `${recordType} ${options.did} was removed by ${srcHandle ?? options.src} ${hashtag}`;

            // await this.makePost(postContent);
            // logger.info(`Handled record takedown: ${postContent}`);
            logger.debug("skipping non-account takedown for " + options.did);
            return;
        }

        const { age: accountAge, handle: handles } = await getAccountAgeAndHandle(options.did);

        if (accountAge !== null && accountAge < SPAM_GRACE_PERIOD_MS) {
            return;
        }

        this.userDatabase.upsert({
            did: options.did,
            takedownSrc: options.src,
            takedownDate: Date.now(),
        });

        const { handle: srcHandles } = await getAccountAgeAndHandle(options.src);

        // acount
        const userHandle = handles ? `${handles[0]}` : options.did;
        // was
        const actionType = LABEL_TYPES[options.label.val] || "labeled";
        // by
        const srcHandlePart = srcHandles ? `${srcHandles[0]}` : `${options.src}`;

        const oldAccountTag =
            accountAge === null
                ? ""
                : accountAge >= 730 * ONE_DAY_MS
                  ? " #veryOldAccountBan"
                  : accountAge >= 365 * ONE_DAY_MS
                    ? " #oldAccountBan"
                    : accountAge >= 180 * ONE_DAY_MS
                      ? " #youngAccountBan"
                      : " #newAccountBan";

        const ageText =
            accountAge !== null ? `\n\nThe account was ${formatDuration(accountAge)} old at the time of banning.` : "";

        const previousHandlesText =
            handles && handles.length > 1 ? `\nPrevious known handles: ${handles.slice(1, 3).join(", ")}` : "";

        // const detailsOfTakedown = `Details:\nLabel: ${options.label.val}\ndid: ${options.label.uri}\nLabel created at: ${options.label.cts}${previousHandlesText}`;

        const postContent = `Account ${userHandle} was ${actionType} by ${srcHandlePart}${ageText} #BskyBans${oldAccountTag}`;
        await this.makePost([postContent]);

        logger.debug(
            `[${srcHandlePart}]`.padEnd(20) +
                `add ${options.label.val}`.padEnd(20) +
                `${userHandle}`.padEnd(40) +
                `(${options.did})`.padEnd(36) +
                `accountAge: ${accountAge !== null ? formatDuration(accountAge) : "unknown"}`,
        );
    }

    public async handleUntakedown(options: TakedownOptions): Promise<void> {
        if (options.did.startsWith("at://")) {
            // const { handle: srcHandle } = await getAccountAgeAndHandle(options.src);

            // let recordType = "Record";
            // let hashtag = "#bskyModeration";

            // if (options.did.includes("/app.bsky.feed.post/")) {
            //     recordType = "Post";
            //     hashtag = "#bskyModeration #postrestored";
            // }

            // const postContent = `${recordType} ${options.did} was restored by ${srcHandle ?? options.src} ${hashtag}`;

            // await this.makePost(postContent);
            // logger.info(`Handled record untakedown: ${postContent}`);
            return; // Exit early!
        }

        const entry = this.userDatabase.getByDidAndSrc(options.did, options.src);

        let timeString = "";

        if (entry) {
            const timeSinceTakedown = entry ? Date.now() - entry.takedownDate : null;
            const timeSinceTakedownStr =
                timeSinceTakedown !== null ? formatDuration(timeSinceTakedown) : "unknown time";
            timeString = ` after ${timeSinceTakedownStr}`;
        }

        const { handle: handles } = await getAccountAgeAndHandle(options.did);
        const { handle: srcHandles } = await getAccountAgeAndHandle(options.src);
        // acount
        const userHandle = handles ? `${handles[0]}` : options.did;
        // was
        const actionType = LABEL_TYPES[options.label.val] || "labeled";
        // by
        const srcHandlePart = srcHandles ? `${srcHandles[0]}` : `${options.src}`;

        const postContent = `Account ${userHandle} was un${actionType} by ${srcHandlePart}${timeString} #BskyUnbans`;

        await this.makePost(postContent);

        this.userDatabase.remove(options.did, options.src);

        // logger.info(`Handled untakedown: ${postContent}`);
        // logger.debug(details);

        logger.debug(
            `[${srcHandlePart}]`.padEnd(20) +
                `remove ${options.label.val}`.padEnd(20) +
                `${userHandle}`.padEnd(40) +
                `(${options.did})`.padEnd(36) +
                `time since takedown: ${timeString.trim()}`,
        );
    }

    public async makePost(postContent: string | string[]): Promise<void> {
        const posts = Array.isArray(postContent) ? postContent : [postContent];

        let rootRef: { uri: string; cid: string } | undefined;
        let parentRef: { uri: string; cid: string } | undefined;

        for (const text of posts) {
            const rt = new RichText({ text });
            await rt.detectFacets(this.agent);

            rt.facets = rt.facets?.map((facet) => {
                if (facet.features?.some((feature) => feature.$type === "app.bsky.richtext.facet#mention")) {
                    return {
                        ...facet,
                        features: facet.features?.filter(
                            (feature) => feature.$type !== "app.bsky.richtext.facet#mention",
                        ),
                    };
                }
                return facet;
            });

            const reply =
                rootRef && parentRef
                    ? {
                          root: { uri: rootRef.uri, cid: rootRef.cid },
                          parent: { uri: parentRef.uri, cid: parentRef.cid },
                      }
                    : undefined;

            const response = await this.agent.post({
                text,
                facets: rt.facets,
                langs: ["en"],
                reply,
            });

            if (!rootRef) rootRef = { uri: response.uri, cid: response.cid };
            parentRef = { uri: response.uri, cid: response.cid };
        }
    }
}
