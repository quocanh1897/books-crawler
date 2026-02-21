load("config.js");

function execute(url, page) {
  var p = page || 1;
  var limit = 50;

  var apiUrl;
  if (url === "updated_at") {
    apiUrl = API_URL + "/rankings?metric=view_count&status=0&limit=" + limit + "&page=" + p;
  } else if (url === "completed") {
    apiUrl = API_URL + "/rankings?metric=view_count&status=2&limit=" + limit + "&page=" + p;
  } else {
    apiUrl = API_URL + "/rankings?metric=" + url + "&limit=" + limit + "&page=" + p;
  }

  var response = fetch(apiUrl);
  if (!response.ok) return Response.error("Failed to fetch rankings");

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
