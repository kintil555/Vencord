/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { addMessagePreSendListener, MessageSendListener, removeMessagePreSendListener } from "@api/MessageEvents";
import definePlugin, { IconComponent } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { MessageActions, MessageStore, Modal, openModal, SelectedChannelStore, TextArea, Toasts, UserStore, useState } from "@webpack/common";

// ========================
// State
// ========================

interface WowEditEntry {
    draftText: string;
    pendingMessageId: string | null; // null = belum kirim, "WAITING" = polling, string = id pesan
}

const wowEditMap = new Map<string, WowEditEntry>();

// ========================
// Modal
// ========================

function WowEditModal({ channelId, modalProps }: { channelId: string; modalProps: any; }) {
    const existing = wowEditMap.get(channelId);
    const [draft, setDraft] = useState(existing?.draftText ?? "");

    function onSave() {
        if (!draft.trim()) {
            wowEditMap.delete(channelId);
        } else {
            wowEditMap.set(channelId, { draftText: draft.trim(), pendingMessageId: null });
        }
        modalProps.onClose();
        Toasts.show({
            message: draft.trim()
                ? `✅ Draft tersimpan: "${draft.trim().slice(0, 30)}${draft.trim().length > 30 ? "…" : ""}"`
                : "🗑️ Draft dihapus",
            type: Toasts.Type.SUCCESS,
            id: Toasts.genId(),
            options: { duration: 2500 }
        });
    }

    function onClear() {
        wowEditMap.delete(channelId);
        modalProps.onClose();
        Toasts.show({
            message: "🗑️ Draft dihapus",
            type: Toasts.Type.SUCCESS,
            id: Toasts.genId(),
            options: { duration: 2000 }
        });
    }

    const kbdStyle: React.CSSProperties = {
        background: "var(--background-secondary)",
        border: "1px solid var(--background-tertiary)",
        borderRadius: "4px",
        padding: "2px 6px",
        fontFamily: "monospace",
        fontSize: "12px",
        color: "var(--text-normal)"
    };

    return (
        <Modal
            {...modalProps}
            title="WowEdit — Set Draft Edit"
            subtitle='Kirim pesan dulu, lalu tekan Ctrl+X untuk trigger edit instan'
            actions={[
                {
                    text: "Hapus Draft",
                    variant: "secondary",
                    onClick: onClear,
                    disabled: !existing
                },
                {
                    text: "Batal",
                    variant: "secondary",
                    onClick: modalProps.onClose
                },
                {
                    text: "Simpan",
                    variant: "primary",
                    onClick: onSave,
                    disabled: !draft.trim()
                }
            ]}
        >
            <div style={{ padding: "8px 0", display: "flex", flexDirection: "column", gap: "12px" }}>
                <div style={{ color: "var(--text-muted)", fontSize: "13px", lineHeight: "1.5" }}>
                    Tulis teks yang akan menggantikan pesan kamu setelah dikirim.
                    Setelah kirim, tekan <kbd style={kbdStyle}>Ctrl+X</kbd> di channel ini untuk trigger edit otomatis.
                </div>
                <TextArea
                    value={draft}
                    onChange={setDraft}
                    placeholder='Contoh: "Hallo semuanya!" (ini yang akan jadi hasil edit)'
                    autosize
                    rows={3}
                />
                {existing?.pendingMessageId && existing.pendingMessageId !== "WAITING" && (
                    <div style={{ color: "var(--status-positive)", fontSize: "13px" }}>
                        ✅ Pesan sudah terkirim! Siap di-trigger dengan Ctrl+X.
                    </div>
                )}
                {existing?.pendingMessageId === "WAITING" && (
                    <div style={{ color: "var(--status-warning)", fontSize: "13px" }}>
                        ⏳ Menunggu pesan terkirim…
                    </div>
                )}
            </div>
        </Modal>
    );
}

// ========================
// ChatBar Button
// ========================

const WowEditIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg
        width={width}
        height={height}
        viewBox="0 0 24 24"
        fill="currentColor"
        className={className}
        xmlns="http://www.w3.org/2000/svg"
    >
        <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z" />
        <path d="M20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
    </svg>
);

const WowEditButton: ChatBarButtonFactory = ({ channel }) => {
    const channelId = channel?.id;
    const [tick, setTick] = useState(0);

    const entry = channelId ? wowEditMap.get(channelId) : undefined;
    const isActive = !!entry;
    const isReady = isActive && !!entry?.pendingMessageId && entry.pendingMessageId !== "WAITING";

    const color = !isActive
        ? "var(--interactive-normal)"
        : isReady
            ? "var(--status-positive)"
            : "var(--status-warning)";

    const tooltip = !isActive
        ? "WowEdit: Set draft edit pesan"
        : isReady
            ? `WowEdit: Siap! Tekan Ctrl+X — "${entry!.draftText.slice(0, 20)}${entry!.draftText.length > 20 ? "…" : ""}"`
            : `WowEdit: Draft aktif "${entry!.draftText.slice(0, 20)}${entry!.draftText.length > 20 ? "…" : ""}" — kirim pesan dulu`;

    function handleClick() {
        if (!channelId) return;
        openModal(props => <WowEditModal channelId={channelId} modalProps={props} />);
        setTimeout(() => setTick(n => n + 1), 300);
    }

    return (
        <ChatBarButton tooltip={tooltip} onClick={handleClick}>
            <svg
                width={20}
                height={20}
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                style={{ color }}
            >
                <path
                    d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z"
                    fill="currentColor"
                />
                <path
                    d="M20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
                    fill="currentColor"
                />
                {isActive && (
                    <circle
                        cx="19"
                        cy="19"
                        r="4"
                        fill={isReady ? "var(--status-positive)" : "var(--status-warning)"}
                    />
                )}
            </svg>
        </ChatBarButton>
    );
};

// ========================
// Plugin
// ========================

let preSendListener: MessageSendListener | null = null;

function handleKeyDown(e: KeyboardEvent) {
    if (!e.ctrlKey || e.key !== "x") return;

    // Biarkan cut normal kalau ada teks diseleksi
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) return;

    // Biarkan cut normal di input/textarea dengan seleksi
    const active = document.activeElement as HTMLInputElement | null;
    if (active) {
        const tag = active.tagName.toLowerCase();
        if ((tag === "input" || tag === "textarea") && active.selectionStart !== active.selectionEnd) return;
    }

    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return;

    const entry = wowEditMap.get(channelId);
    if (!entry) return;

    if (!entry.pendingMessageId || entry.pendingMessageId === "WAITING") {
        Toasts.show({
            message: "⏳ WowEdit: Kirim pesan dulu sebelum trigger edit!",
            type: Toasts.Type.FAILURE,
            id: Toasts.genId(),
            options: { duration: 2000 }
        });
        return;
    }

    e.preventDefault();
    e.stopPropagation();

    const { pendingMessageId, draftText } = entry;
    wowEditMap.delete(channelId);

    MessageActions.editMessage(channelId, pendingMessageId, { content: draftText });

    Toasts.show({
        message: `✏️ WowEdit: Pesan diedit → "${draftText.slice(0, 40)}${draftText.length > 40 ? "…" : ""}"`,
        type: Toasts.Type.SUCCESS,
        id: Toasts.genId(),
        options: { duration: 2500 }
    });
}

export default definePlugin({
    name: "WowEdit",
    description: "Set draft edit sebelum kirim pesan, lalu tekan Ctrl+X untuk trigger edit instan — seolah-olah kamu ngetik super cepat!",
    authors: [{ name: "kintil555", id: 0n }],
    tags: ["edit", "fun", "prank"],

    chatBarButton: {
        icon: WowEditIcon,
        render: WowEditButton,
    },

    start() {
        preSendListener = (channelId, _msg, _opts) => {
            const entry = wowEditMap.get(channelId);
            // Hanya proses jika ada entry yang belum punya pendingMessageId
            if (!entry || entry.pendingMessageId !== null) return;

            entry.pendingMessageId = "WAITING";
            wowEditMap.set(channelId, entry);

            // Poll setelah 700ms untuk cari pesan terbaru dari user
            setTimeout(() => {
                const me = UserStore.getCurrentUser();
                if (!me) return;

                const msgs = MessageStore.getMessages(channelId);
                if (!msgs) return;

                // _array adalah internal array di MessageStore
                const arr: Message[] = (msgs as any)._array ?? [];
                const latest = [...arr].reverse().find(m => m.author?.id === me.id);

                if (latest) {
                    const current = wowEditMap.get(channelId);
                    if (current && current.pendingMessageId === "WAITING") {
                        current.pendingMessageId = latest.id;
                        wowEditMap.set(channelId, current);
                    }
                }
            }, 700);
        };

        addMessagePreSendListener(preSendListener);
        document.addEventListener("keydown", handleKeyDown, true);
    },

    stop() {
        if (preSendListener) {
            removeMessagePreSendListener(preSendListener);
            preSendListener = null;
        }
        document.removeEventListener("keydown", handleKeyDown, true);
        wowEditMap.clear();
    },
});
