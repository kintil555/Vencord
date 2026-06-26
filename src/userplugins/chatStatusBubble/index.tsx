/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { addMessageDecoration, removeMessageDecoration } from "@api/MessageDecorations";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Activity } from "@vencord/discord-types";
import { ActivityType } from "@vencord/discord-types/enums";
import { IconUtils, PresenceStore, Tooltip, useStateFromStores } from "@webpack/common";

const logger = new Logger("ChatStatusBubble", "#fcd34d");

const settings = definePluginSettings({
    onlyOnHover: {
        type: OptionType.BOOLEAN,
        description: "Tampilkan bubble status hanya saat kursor di atas nama/avatar (selalu menyiapkan ikon kecil di sebelah nama)",
        default: true,
    },
    showEmoji: {
        type: OptionType.BOOLEAN,
        description: "Tampilkan emoji custom status di dalam bubble",
        default: true,
    },
    compactDot: {
        type: OptionType.BOOLEAN,
        description: "Tampilkan ikon 💭 kecil di sebelah nama pengirim ketika dia punya custom status",
        default: true,
    },
});

function getCustomStatus(userId: string): Activity | undefined {
    return PresenceStore.getActivities(userId).find(a => a.type === ActivityType.CUSTOM_STATUS);
}

function StatusEmoji({ activity }: { activity: Activity; }) {
    if (!settings.store.showEmoji || activity.emoji == null) return null;

    const { id, name, animated } = activity.emoji;

    // Emoji custom Discord (punya id) vs emoji unicode bawaan (tidak punya id)
    if (id) {
        const url = IconUtils.getEmojiURL({ id, animated, size: 20 });
        return (
            <img
                className="vc-csb-emoji"
                src={url}
                alt={name}
                draggable={false}
            />
        );
    }

    return <span className="vc-csb-emoji vc-csb-emoji-unicode">{name}</span>;
}

function StatusBubbleContent({ activity }: { activity: Activity; }) {
    return (
        <div className="vc-csb-bubble">
            <StatusEmoji activity={activity} />
            <span className="vc-csb-text">{activity.state}</span>
        </div>
    );
}

function ChatStatusIndicator({ userId }: { userId: string; }) {
    const activity = useStateFromStores(
        [PresenceStore],
        () => getCustomStatus(userId),
        [userId],
        (a, b) => a?.state === b?.state && a?.emoji?.id === b?.emoji?.id && a?.emoji?.name === b?.emoji?.name
    );

    if (activity == null || !activity.state) return null;

    // Mode "selalu tampil" — bubble langsung muncul tanpa perlu hover terpisah,
    // karena ikonnya sendiri sudah jadi trigger Tooltip saat dihover.
    return (
        <Tooltip text={<StatusBubbleContent activity={activity} />}>
            {tooltipProps => (
                settings.store.compactDot ? (
                    <span
                        {...tooltipProps}
                        className="vc-csb-icon"
                        aria-label="Status pengguna"
                    >
                        💭
                    </span>
                ) : (
                    // Tetap render span tak terlihat agar Tooltip tetap bisa
                    // dipasang ke seluruh blok nama lewat CSS, lihat style.css
                    <span {...tooltipProps} className="vc-csb-icon vc-csb-icon-hidden" />
                )
            )}
        </Tooltip>
    );
}

export default definePlugin({
    name: "ChatStatusBubble",
    description: "Menampilkan custom status seseorang (mis. 💭 Hari ini kerja) sebagai bubble saat kursor diarahkan ke nama/avatar mereka di chat, tanpa perlu membuka profilnya.",
    authors: [{ name: "kintil555", id: 0n }],
    settings,

    dependencies: ["MessageDecorationsAPI"],

    start() {
        addMessageDecoration("ChatStatusBubble", props => {
            const userId = props?.message?.author?.id;
            if (userId == null) return null;
            return <ChatStatusIndicator userId={userId} />;
        });
    },

    stop() {
        removeMessageDecoration("ChatStatusBubble");
    },
});
