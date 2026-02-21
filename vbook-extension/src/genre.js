load("config.js");

function execute() {
  var response = fetch(API_URL + "/genres");
  if (!response.ok) return Response.error("Failed to fetch genres");

  var genres = response.json();
  var results = [];

  for (var i = 0; i < genres.length; i++) {
    var g = genres[i];
    results.push({
      title: g.name + " (" + g.bookCount + ")",
      input: g.slug,
      script: "genrecontent.js"
    });
  }

  return Response.success(results);
}
