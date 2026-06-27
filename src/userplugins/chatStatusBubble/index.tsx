/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { definePluginSettings } from "@api/Settings";
import { classes } from "@utils/misc";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Activity } from "@vencord/discord-types";
import { ActivityType } from "@vencord/discord-types/enums";
import { findCssClassesLazy } from "@webpack";
import { IconUtils, Message, PresenceStore, Tooltip, useStateFromStores } from "@webpack/common";

const logger = new Logger("ChatStatusBubble", "#fcd34d");

const TimestampClasses = findCssClassesLazy("timestampInline", "timestamp");

const settings = definePluginSettings({
    showEmoji: {
        type: OptionType.BOOLEAN,
        description: "Tampilkan emoji custom status",
        default: true,
    },
    showTextStatus: {
        type: OptionType.BOOLEAN,
        description: "Tampilkan teks custom status (jika ada) di tooltip",
        default: true,
    },
});

function getCustomStatus(userId: string): Activity | undefined {
    try {
        const acts = PresenceStore.getActivities(userId);
        return acts?.find(a => a.type === ActivityType.CUSTOM_STATUS);
    } catch (e) {
        logger.error("getCustomStatus error:", e);
        return undefined;
    }
}

function StatusEmoji({ activity }: { activity: Activity; }) {
    if (!settings.store.showEmoji || activity.emoji == null) return null;

    const { id, name, animated } = activity.emoji;

    if (id) {
        // Emoji custom Discord (punya id) — pastikan id ada sebelum kirim ke getEmojiURL
        const url = IconUtils.getEmojiURL({ id, animated: animated ?? false, size: 20 });
        return (
            <img
                className="vc-csb-emoji"
                src={url}
                alt={name ?? "emoji"}
                draggable={false}
            />
        );
    }

    // Emoji unicode bawaan (tidak punya id)
    if (name) {
        return <span className="vc-csb-emoji vc-csb-emoji-unicode">{name}</span>;
    }

    return null;
}

function TooltipContent({ activity }: { activity: Activity; }) {
    return (
        <div className="vc-csb-tooltip-content">
            <StatusEmoji activity={activity} />
            {settings.store.showTextStatus && activity.state && (
                <span className="vc-csb-text">{activity.state}</span>
            )}
        </div>
    );
}

function StatusBubble({ userId }: { userId: string; }) {
    const activity = useStateFromStores(
        [PresenceStore],
        () => getCustomStatus(userId),
        [userId],
        (a, b) => {
            if (a == null && b == null) return true;
            if (a == null || b == null) return false;
            return (
                a.state === b.state &&
                a.emoji?.id === b.emoji?.id &&
                a.emoji?.name === b.emoji?.name
            );
        }
    );

    // Tampilkan bubble hanya jika ada emoji ATAU teks status
    if (activity == null) return null;
    const hasContent = activity.emoji != null || (activity.state != null && activity.state.length > 0);
    if (!hasContent) return null;

    return (
        <Tooltip text={<TooltipContent activity={activity} />}>
            {tooltipProps => (
                <span
                    {...tooltipProps}
                    className={classes(
                        "vc-csb-bubble-icon",
                        TimestampClasses.timestampInline,
                        TimestampClasses.timestamp
                    )}
                    aria-label="Custom status"
                >
                    💭
                </span>
            )}
        </Tooltip>
    );
}

const StatusBubbleWrapper = ErrorBoundary.wrap(
    ({ message }: { message: Message; }) => {
        const userId = message?.author?.id;
        if (userId == null || message?.author?.bot) return null;
        return <StatusBubble userId={userId} />;
    },
    { noop: true }
);

export default definePlugin({
    name: "ChatStatusBubble",
    description: "Menampilkan custom status seseorang sebagai bubble 💭 di sebelah nama mereka di chat, muncul ketika kursor diarahkan ke ikon tersebut.",
    authors: [{ name: "kintil555", id: 0n }],
    settings,

    patches: [
        {
            // Patch area header pesan (nama + timestamp) — sama seperti userMessagesPronouns
            find: "showCommunicationDisabledStyles",
            replacement: {
                match: /(?<=return\s*\(0,\i\.jsxs?\)\(.+!\i&&)(\(0,\i.jsxs?\)\(.+?\{.+?\}\))/,
                replace: "[$1, $self.StatusBubbleWrapper(arguments[0])]"
            }
        }
    ],

    StatusBubbleWrapper,
});
