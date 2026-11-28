"use client";

import type { RefObject } from "react";
import { copy } from "@/copy";
import { URL_MAX, normalizeUrl } from "@/shared/url";

/** The URL field, for a report of its error on submit. */
export interface UrlFieldHandle {
  reportValidity(): boolean;
}

/**
 * The URL of an item (#140), in the item sheet and in the add bar. It is
 * text with the URL keyboard, not type="url": the browser refuses a URL
 * with no scheme, and normalizeUrl adds https:// to it. Other text makes
 * the field invalid, thus its form does not submit.
 */
export function UrlField({
  label,
  placeholder,
  value,
  onChange,
  handleRef,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  handleRef?: RefObject<UrlFieldHandle | null>;
}) {
  return (
    <wa-input
      // A new callback each render: it sets the validity of each value,
      // also when the field mounts again with a value in it.
      ref={(field) => {
        if (handleRef) handleRef.current = field;
        // Not there before the element is defined.
        if (typeof field?.setCustomValidity !== "function") return;
        field.setCustomValidity(
          normalizeUrl(value) === undefined ? copy.common.urlInvalid : "",
        );
      }}
      label={label}
      placeholder={placeholder}
      value={value}
      onInput={(e) => onChange((e.target as HTMLInputElement).value)}
      inputmode="url"
      autocapitalize="off"
      autocorrect={false}
      spellcheck={false}
      maxlength={URL_MAX}
      with-clear
    ></wa-input>
  );
}
