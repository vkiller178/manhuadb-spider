import { loadUrl } from "./pupppeteer";
import DotEnv from "dotenv";
import PDFDocument from "pdfkit";
import fs from "fs";
import {
  saveCachePath,
  resolvePath,
  saveFilePath,
  execInChildProcess
} from "./file";
import { loggy } from "./loggy";

DotEnv.config();

export const isDev = process.env.ENV === "development";

function getUrl(uri) {
  const domain = "https://www.manhuadb.com";
  return domain + uri;
}

async function loadPage(bookPath: string, pageNum: number): Promise<string> {
  let imgPath = saveCachePath(
    bookPath.replace(/\//g, "-") + "-" + pageNum + ".png"
  );

  if (fs.existsSync(imgPath)) {
    return imgPath;
  }
  const pagePath = bookPath.replace(".", `_p${pageNum}.`);
  const [page, ins] = await loadUrl(getUrl(pagePath));

  try {
    const img = await page.$(".img-fluid.show-pic");
    await img?.screenshot({
      path: imgPath,
      omitBackground: true
    });
  } catch (error) {
    imgPath = "";
  } finally {
    ins.status = "free";
  }

  return imgPath;
}

/**
 *
 * @param path eg: "/manhua/159/69_797.html"
 */
async function loadBook(path: string): Promise<boolean> {
  const [page, ins] = await loadUrl(getUrl(path));
  let allBookPage: number | undefined;
  let title: string = "";
  const retry = (reason: string) => {
    loggy(`重试,${path + "原因：" + reason}`);
    return false;
  };
  try {
    allBookPage = await (
      await page.$(".form-control.vg-page-selector")
    )?.$$eval("option", list => list.length);

    title = await page.title();
    // release ins
    ins.status = "free";
  } catch (error) {
    allBookPage = undefined;
  }

  if (allBookPage === undefined) return retry("没有获取到画册的页数");

  const pdfPath = saveFilePath(resolvePath("../output", `${title}.pdf`));

  if (fs.existsSync(pdfPath)) return true;

  const pdfCachePath = saveFilePath(resolvePath("../output", `.${title}.pdf`));

  const bookPDF = new PDFDocument();
  bookPDF.pipe(fs.createWriteStream(pdfCachePath));
  bookPDF.text(path);

  let index = 1;

  for (; index <= allBookPage; index++) {
    const imagePath = await loadPage(path, index);
    if (!imagePath) break;
    try {
      bookPDF.addPage().image(imagePath, {
        align: "center",
        valign: "center",
        width: 450
      });
    } catch (error) {
      loggy(`读取 ${imagePath} 出现异常`);
      execInChildProcess(`rm ${imagePath}`);
      break;
    }
  }

  if (index < allBookPage) return retry(`加载画册第${index}页的时候出现异常`);

  bookPDF.save().end();
  // 删除缓存文件？
  execInChildProcess(
    `rm ${saveCachePath(path.replace(/\//g, "-") + "-*.png")}`
  );
  execInChildProcess(`mv '${pdfCachePath}' '${pdfPath}'`);
  loggy(`漫画${path}下载完成`, { always: true });

  return true;
}

(async () => {
  if (process.env.ID === undefined) return;
  const mainUrl = getUrl(`/manhua/${process.env.ID}`);
  const [mainPage, ins] = await loadUrl(mainUrl);
  type status = "pending" | "done" | "error";
  // 所有册的id
  let pids: string[] = await mainPage.$$eval(
    ".active .links-of-books.num_div .sort_div a",
    list => {
      let pids: string[] = [];
      for (const ele of list) {
        const id = ele.getAttribute("href");
        if (id) {
          pids.push(id);
        }
      }
      return pids;
    }
  );

  type Book = { status: status; path: string };

  if (pids.length === 0) return;

  let books: Book[] = pids.map<Book>(p => ({ status: "error", path: p }));

  ins.status = "free";

  const timer = setInterval(() => {
    const errorBook = books.filter(book => book.status === "error");
    if (errorBook.length > 0) {
      for (const book of errorBook) {
        book.status = "pending";
        loadBook(book.path).then(res => {
          book.status = res ? "done" : "error";
        });
      }
    }
    if (books.every(book => book.status === "done")) {
      clearInterval(timer);
      loggy("漫画下载完成", { always: true });
      process.exit(0);
    }
  }, 1000);
})();
