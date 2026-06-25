/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";

export interface FormatAction {
    label: string;
    title: string;
    /** Penanda yang ditambahkan sebelum & sesudah teks terseleksi */
    wrap: [string, string];
}

export const FORMAT_ACTIONS: FormatAction[] = [
    { label: "B", title: "Bold", wrap: ["**", "**"] },
    { label: "I", title: "Italic", wrap: ["*", "*"] },
    { label: "U", title: "Underline", wrap: ["__", "__"] },
    { label: "S", title: "Strikethrough", wrap: ["~~", "~~"] },
    { label: "<>", title: "Inline Code", wrap: ["`", "`"] },
    { label: "Besar", title: "Heading (besar)", wrap: ["# ", ""] },
    { label: "Kecil", title: "Subtext (kecil)", wrap: ["-# ", ""] },
];

/**
 * Sisipkan format markdown di sekitar teks yang sedang diseleksi pada textarea HTML asli.
 * Mengembalikan string baru dan posisi seleksi baru, supaya caret bisa diset ulang.
 */
export function applyFormat(
    value: string,
    selectionStart: number,
    selectionEnd: number,
    wrap: [string, string]
): { text: string; newStart: number; newEnd: number; } {
    const [before, after] = wrap;
    const selected = value.slice(selectionStart, selectionEnd);
    const newText =
        value.slice(0, selectionStart) +
        before + selected + after +
        value.slice(selectionEnd);

    const newStart = selectionStart + before.length;
    const newEnd = newStart + selected.length;

    return { text: newText, newStart, newEnd };
}

interface FormatToolbarProps {
    /** Ref ke elemen textarea asli (HTMLTextAreaElement) supaya bisa baca posisi seleksi & set ulang caret */
    getTextareaEl: () => HTMLTextAreaElement | null;
    value: string;
    onChange(newValue: string): void;
}

export function FormatToolbar({ getTextareaEl, value, onChange }: FormatToolbarProps) {
    function handleClick(action: FormatAction) {
        const el = getTextareaEl();
        const start = el?.selectionStart ?? value.length;
        const end = el?.selectionEnd ?? value.length;

        const { text, newStart, newEnd } = applyFormat(value, start, end, action.wrap);
        onChange(text);

        // Set ulang fokus & seleksi setelah re-render
        requestAnimationFrame(() => {
            const elAgain = getTextareaEl();
            if (elAgain) {
                elAgain.focus();
                elAgain.setSelectionRange(newStart, newEnd);
            }
        });
    }

    return (
        <div style={{ display: "flex", gap: "4px", marginBottom: "6px", flexWrap: "wrap" }}>
            {FORMAT_ACTIONS.map(action => (
                <Button
                    key={action.title}
                    size="xs"
                    variant="secondary"
                    title={action.title}
                    onClick={() => handleClick(action)}
                >
                    {action.label}
                </Button>
            ))}
        </div>
    );
}
