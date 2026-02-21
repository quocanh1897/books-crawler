load("config.js");

function execute(url) {
  var slug = url.replace(/.*\/doc-truyen\//, "").replace(/\/.*/, "").replace(/\?.*/, "");

  var response = fetch(API_URL + "/books/by-slug/" + slug + "/chapters");
  if (!response.ok) return Response.error("Failed to fetch chapters");

  var json = response.json();
  var chapters = json.chapters || [];
  var results = [];

  for (var i = 0; i < chapters.length; i++) {
    var ch = chapters[i];
    results.push({
      name: ch.title,
      url: "/doc-truyen/" + slug + "/chuong-" + ch.indexNum,
      host: BASE_URL
    });
  }

  return Response.success(results);
}
