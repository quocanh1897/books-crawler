load("config.js");

function execute(url) {
  var parts = url.replace(/.*\/doc-truyen\//, "").split("/");
  var slug = parts[0];
  var indexMatch = (parts[1] || "").match(/^chuong-(\d+)/);
  if (!indexMatch) return Response.error("Invalid chapter URL");
  var indexNum = indexMatch[1];

  var response = fetch(API_URL + "/books/by-slug/" + slug + "/chapters/" + indexNum);
  if (!response.ok) return Response.error("Chapter not found");

  var chapter = response.json();
  var body = chapter.body || "";

  var html = "<h3>" + chapter.title + "</h3>";
  var paragraphs = body.split("\n");
  for (var i = 0; i < paragraphs.length; i++) {
    var p = paragraphs[i].trim();
    if (p.length > 0) {
      html += "<p>" + p + "</p>";
    }
  }

  return Response.success(html);
}
