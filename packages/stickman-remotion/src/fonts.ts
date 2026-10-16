import notoSansBold from '../assets/fonts/NotoSans-Bold.woff2';
import notoSansScBold from '../assets/fonts/NotoSansSC-Bold.woff2';

export const localFontFaces = `
@font-face {
  font-family: "OpenCreator Noto Sans";
  src: url("${notoSansBold}") format("woff2");
  font-style: normal;
  font-weight: 700;
  font-display: block;
}
@font-face {
  font-family: "OpenCreator Noto Sans SC";
  src: url("${notoSansScBold}") format("woff2");
  font-style: normal;
  font-weight: 700;
  font-display: block;
}
`;

export const localFontFamily = '"OpenCreator Noto Sans SC", "OpenCreator Noto Sans", sans-serif';
