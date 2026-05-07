import "dotenv/config";
import { logger } from "./logger";
import { LabelStream } from "./labelStream";
import { AtpAgent } from "@atproto/api";
import { PostMaker } from "./postMaker";


async function main() {
    logger.info("Starting application...");

    const agent = new AtpAgent({
        service: process.env.ACCOUNT_PDS_URL || "https://bsky.social",

    })

    await agent.login({
        identifier: process.env.ACCOUNT_USERNAME!,
        password: process.env.ACCOUNT_PASSWORD!,
    });

    const postMaker = new PostMaker(agent);



    // create label stream instance and start it
    const labelStream = new LabelStream({
        allowedLabelers: ["did:plc:ar7c4by46qjdydhdevvrndac"],
        onTakedown: async (did, banned, src, label) => {
            if (banned) {
                postMaker.handleTakedown({ did, src, label }).catch((err) => {
                    logger.error({ err, did, src }, "Error handling takedown");
                });
            } else {
                postMaker.handleUntakedown({ did, src, label }).catch((err) => {
                    logger.error({ err, did, src }, "Error handling untakedown");
                });
            }
            
        },
        onError: (err) => {
            logger.error({ err }, "LabelStream error");
        },
    });

    labelStream.start();
}

main();