load("config.js");

function execute(key, page) {
  if (!key || key.length < 2) return Response.success([], null);

  var limit = 20;
  var apiUrl =
    API_URL +
    "/search?scope=books&source=all&limit=" +
    limit +
    "&q=" +
    encodeURIComponent(key);

  var response = fetch(apiUrl);
  if (!response.ok) return Response.error("Search failed");

  var json = response.json();
  var items = json.results || [];
  var results = [];

  for (var i = 0; i < items.length; i++) {
    var book = items[i];
    var cover = BASE_URL + "/covers/" + book.id + ".jpg";
    var desc = (book.chapter_count || 0) + " chương";
    if (book.bookmark_count > 0)
      desc += " · " + book.bookmark_count + " đánh dấu";

    results.push({
      name: book.name,
      link: "/doc-truyen/" + book.slug,
      host: BASE_URL,
      cover: cover,
      description: desc,
    });
  }

  return Response.success(results, null);
}
