import { Tooltip } from "@excalidraw/excalidraw/components/Tooltip";
import { shield } from "@excalidraw/excalidraw/components/icons";
import { useI18n } from "@excalidraw/excalidraw/i18n";

export const EncryptedIcon = () => {
  const { t } = useI18n();

  return (
    // FlyLaTeX: rendered as a non-interactive indicator instead of a link, so we
    // don't send users to the upstream marketing site
    // <a
    //   href="https://plus.excalidraw.com/blog/end-to-end-encryption"
    //   target="_blank"
    //   rel="noopener"
    // >
    <div
      className="encrypted-icon tooltip"
      aria-label={t("encrypted.tooltip")}
      role="img"
    >
      <Tooltip label={t("encrypted.tooltip")} long={true}>
        {shield}
      </Tooltip>
    </div>
    // </a>
  );
};
