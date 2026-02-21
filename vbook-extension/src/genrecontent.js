load("config.js");

function execute(url, page) {
  var p = page || 1;
  var limit = 50;
  var apiUrl = API_URL + "/rankings?metric=view_count&genre=" + url + "&limit=" + limit + "&page=" + p;

  var response = fetch(apiUrl);
  if (!response.ok) return Response.error("Failed to fetch genre books");

  var json = response.json();
  var items = json.data || [];
  var totalPages = json.totalPages || 1;
  var results = [];

  for (var i = 0; i < items.length; i++) {
    var book = items[i];
    var cover = book.coverUrl
      ? BASE_URL + book.coverUrl
      : BASE_URL + "/covers/" + book.id + ".jpg";
    var desc = book.chapterCount + " chương";
    if (book.author) desc += " · " + book.author.name;

    results.push({
      name: book.name,
      link: "/doc-truyen/" + book.slug,
      host: BASE_URL,
      cover: cover,
      description: desc
    });
  }

  var next = p < totalPages ? (p + 1) : null;
  return Response.success(results, next);
}
