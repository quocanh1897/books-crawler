load("config.js");

function execute(url) {
  var slug = url.replace(/.*\/doc-truyen\//, "").replace(/\/.*/, "").replace(/\?.*/, "");

  var response = fetch(API_URL + "/books/by-slug/" + slug);
  if (!response.ok) return Response.error("Book not found");

  var book = response.json();

  var cover = book.coverUrl
    ? BASE_URL + book.coverUrl
    : BASE_URL + "/covers/" + book.id + ".jpg";

  var ongoing = book.status !== 2;

  var statusText = "Còn tiếp";
  if (book.status === 2) statusText = "Hoàn thành";
  if (book.status === 3) statusText = "Tạm dừng";

  var detail = statusText + " · " + book.chapterCount + " chương · " + formatNumber(book.wordCount) + " chữ";
  if (book.viewCount > 0) detail += " · " + formatNumber(book.viewCount) + " lượt xem";
  if (book.bookmarkCount > 0) detail += " · " + formatNumber(book.bookmarkCount) + " đánh dấu";

  var genres = [];
  for (var i = 0; i < book.genres.length; i++) {
    var g = book.genres[i];
    genres.push({
      title: g.name,
      input: g.slug,
      script: "genrecontent.js"
    });
  }

  return Response.success({
    name: book.name,
    cover: cover,
    host: BASE_URL,
    author: book.author ? book.author.name : "",
    description: book.synopsis || "",
    detail: detail,
    ongoing: ongoing,
    genres: genres
  });
}

function formatNumber(n) {
  if (!n) return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return "" + n;
}
