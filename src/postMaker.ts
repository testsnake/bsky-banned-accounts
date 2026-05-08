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

export class PostMaker {
    private userDatabase = UserDatabase.getInstance();
    private agent: AtpAgent;
    constructor(agent: AtpAgent) {
        this.agent = agent;
    }

    public async handleTakedown(options: TakedownOptions): Promise<void> {
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

        const oldAccountTag =
            accountAge === null
                ? ""
                : accountAge >= 365 * ONE_DAY_MS
                  ? " #oldAccountBan"
                  : accountAge >= 180 * ONE_DAY_MS
                    ? " #youngAccountBan"
                    : " #newAccountBan";

        const ageText =
            accountAge !== null ? `\n\nThe account was ${formatDuration(accountAge)} old at the time of banning.` : "";

        const previousHandlesText =
            handles && handles.length > 1 ? `\n\nPrevious known handles: ${handles.slice(1, 3).join(", ")}` : "";

        const postContent = `Account ${handles?.[0] ?? options.did} was banned by ${srcHandles?.[0] ?? options.src}.${ageText}${previousHandlesText} #BskyBans${oldAccountTag}`;
        await this.makePost(postContent);

        logger.info(`Handled takedown: ${postContent}`);
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

        const postContent = `Account ${handles?.[0] ?? options.did} was unbanned by ${srcHandles?.[0] ?? options.src}${timeString} #BskyUnbans`;

        await this.makePost(postContent);

        this.userDatabase.remove(options.did, options.src);

        logger.info(`Handled untakedown: ${postContent}`);
    }

    public async makePost(postContent: string): Promise<void> {
        const rt = new RichText({ text: postContent });
        await rt.detectFacets(this.agent);

        // remove accidental mentions, dont wanna get banned for mass mentioning people
        rt.facets = rt.facets?.map((facet) => {
            if (facet.features?.some((feature) => feature.$type === "app.bsky.richtext.facet#mention")) {
                return {
                    ...facet,
                    features: facet.features?.filter((feature) => feature.$type !== "app.bsky.richtext.facet#mention"),
                };
            }
            return facet;
        });

        await this.agent.post({
            text: postContent,
            facets: rt.facets,
            langs: ["en"],
        });
    }
}
